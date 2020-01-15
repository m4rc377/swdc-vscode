import { workspace, ConfigurationTarget, window, commands } from "vscode";

import {
    softwareGet,
    softwarePut,
    isResponseOk,
    softwarePost,
    serverIsAvailable
} from "./http/HttpClient";
import {
    getItem,
    setItem,
    nowInSecs,
    getSessionFileCreateTime,
    getOs,
    getVersion,
    getHostname,
    getEditorSessionToken,
    buildLoginUrl,
    launchWebUrl,
    logIt,
    getPluginId,
    getCommitSummaryFile,
    getSummaryInfoFile,
    getSectionHeader,
    humanizeMinutes,
    getDashboardRow,
    getDashboardFile,
    isLinux
} from "./Util";
import { buildWebDashboardUrl } from "./menu/MenuManager";
import { DEFAULT_SESSION_THRESHOLD_SECONDS } from "./Constants";
import { LoggedInState } from "./model/models";
import { EventHandler } from "./event/EventHandler";
import { SummaryManager } from "./controller/SummaryManager";
const fs = require("fs");
const moment = require("moment-timezone");

let connectState: LoggedInState = null;
let lastLoggedInCheckTime = null;
let toggleFileEventLogging = null;

let userFetchTimeout = null;

const summaryManager: SummaryManager = SummaryManager.getInstance();

export function getConnectState() {
    return connectState;
}

export function getToggleFileEventLoggingState() {
    if (toggleFileEventLogging === null) {
        toggleFileEventLogging = workspace
            .getConfiguration()
            .get("toggleFileEventLogging");
    }
    return toggleFileEventLogging;
}

/**
 * get the app jwt
 */
export async function getAppJwt(serverIsOnline) {
    if (serverIsOnline) {
        // get the app jwt
        let resp = await softwareGet(
            `/data/apptoken?token=${nowInSecs()}`,
            null
        );
        if (isResponseOk(resp)) {
            return resp.data.jwt;
        }
    }
    return null;
}

export async function isLoggedOn(serverIsOnline) {
    let jwt = getItem("jwt");
    if (serverIsOnline && jwt) {
        let api = "/users/plugin/state";
        let resp = await softwareGet(api, jwt);
        if (isResponseOk(resp) && resp.data) {
            // NOT_FOUND, ANONYMOUS, OK, UNKNOWN
            let state = resp.data.state ? resp.data.state : "UNKNOWN";
            if (state === "OK") {
                let sessionEmail = getItem("name");
                let email = resp.data.email;
                if (sessionEmail !== email) {
                    setItem("name", email);
                }
                // check the jwt
                let pluginJwt = resp.data.jwt;
                if (pluginJwt && pluginJwt !== jwt) {
                    // update it
                    setItem("jwt", pluginJwt);
                }

                let checkStatus = getItem("check_status");
                if (checkStatus) {
                    // update it to null, they've logged in
                    setItem("check_status", null);
                }

                return { loggedOn: true, state };
            }
            // return the state that is returned
            return { loggedOn: false, state };
        }
    }
    return { loggedOn: false, state: "UNKNOWN" };
}

export function clearCachedLoggedInState() {
    connectState = null;
}

export async function getCachedLoggedInState(): Promise<LoggedInState> {
    if (!connectState) {
        const serverIsOnline = await serverIsAvailable();
        // doesn't exist yet, use the api
        await getUserStatus(serverIsOnline, true);
    }
    return connectState;
}

/**
 * check if the user is registered or not
 * return {loggedIn: true|false}
 */
export async function getUserStatus(serverIsOnline, ignoreCache = false) {
    if (!ignoreCache && connectState) {
        // ignore cache is true and we have a logged in cache state
        if (lastLoggedInCheckTime) {
            const threshold = 60 * 5;
            // check to see if we should invalide the check time
            if (moment().unix() - lastLoggedInCheckTime > threshold) {
                // set logged in cache state to null as well as the check time
                lastLoggedInCheckTime = null;
                connectState = null;
            }
        } else {
            // it's null, set it
            lastLoggedInCheckTime = moment().unix();
        }
        if (connectState) {
            return connectState;
        }
    }

    let loggedIn = false;
    if (serverIsOnline) {
        // refetch the jwt then check if they're logged on
        const loggedInResp = await isLoggedOn(serverIsOnline);
        // set the loggedIn bool value
        loggedIn = loggedInResp.loggedOn;
    }

    logIt(`Checking login status, logged in: ${loggedIn}`);

    connectState = new LoggedInState();
    connectState.loggedIn = loggedIn;

    if (!loggedIn) {
        let name = getItem("name");
        // only update the name if it's not null
        if (name) {
            setItem("name", null);
        }
    }

    if (serverIsOnline && loggedIn) {
        sendHeartbeat(`STATE_CHANGE:LOGGED_IN:${loggedIn}`, serverIsOnline);

        if (loggedIn) {
            // they've logged in, update the preferences
            initializePreferences(serverIsOnline);
        }
    }

    return connectState;
}

export async function getUser(serverIsOnline, jwt) {
    if (jwt && serverIsOnline) {
        let api = `/users/me`;
        let resp = await softwareGet(api, jwt);
        if (isResponseOk(resp)) {
            if (resp && resp.data && resp.data.data) {
                const user = resp.data.data;
                if (user.registered === 1) {
                    // update jwt to what the jwt is for this spotify user
                    setItem("name", user.email);

                    if (!connectState) {
                        connectState = new LoggedInState();
                    }
                    connectState.loggedIn = true;
                }
                return user;
            }
        }
    }
    return null;
}

export async function initializePreferences(serverIsOnline) {
    let jwt = getItem("jwt");
    // use a default if we're unable to get the user or preferences
    let sessionThresholdInSec = DEFAULT_SESSION_THRESHOLD_SECONDS;

    if (jwt && serverIsOnline) {
        let user = await getUser(serverIsOnline, jwt);
        if (user && user.preferences) {
            // obtain the session threshold in seconds "sessionThresholdInSec"
            sessionThresholdInSec =
                user.preferences.sessionThresholdInSec ||
                DEFAULT_SESSION_THRESHOLD_SECONDS;

            let userId = parseInt(user.id, 10);
            let prefs = user.preferences;
            let prefsShowGit =
                prefs.showGit !== null && prefs.showGit !== undefined
                    ? prefs.showGit
                    : null;
            let prefsShowRank =
                prefs.showRank !== null && prefs.showRank !== undefined
                    ? prefs.showRank
                    : null;

            if (prefsShowGit === null || prefsShowRank === null) {
                await sendPreferencesUpdate(userId, prefs);
            } else {
                if (prefsShowGit !== null) {
                    await workspace
                        .getConfiguration()
                        .update(
                            "showGitMetrics",
                            prefsShowGit,
                            ConfigurationTarget.Global
                        );
                }
                if (prefsShowRank !== null) {
                    // await workspace
                    //     .getConfiguration()
                    //     .update(
                    //         "showWeeklyRanking",
                    //         prefsShowRank,
                    //         ConfigurationTarget.Global
                    //     );
                }
            }
        }
    }

    // update the session threshold in seconds config
    setItem("sessionThresholdInSec", sessionThresholdInSec);
}

async function sendPreferencesUpdate(userId, userPrefs) {
    let api = `/users/${userId}`;

    let showGitMetrics = workspace.getConfiguration().get("showGitMetrics");
    // let showWeeklyRanking = workspace
    //     .getConfiguration()
    //     .get("showWeeklyRanking");
    userPrefs["showGit"] = showGitMetrics;
    // userPrefs["showRank"] = showWeeklyRanking;

    // update the preferences
    // /:id/preferences
    api = `/users/${userId}/preferences`;
    let resp = await softwarePut(api, userPrefs, getItem("jwt"));
    if (isResponseOk(resp)) {
        logIt("update user code time preferences");
    }
}

export async function updatePreferences() {
    toggleFileEventLogging = workspace
        .getConfiguration()
        .get("toggleFileEventLogging");

    let showGitMetrics = workspace.getConfiguration().get("showGitMetrics");
    // let showWeeklyRanking = workspace
    //     .getConfiguration()
    //     .get("showWeeklyRanking");

    // get the user's preferences and update them if they don't match what we have
    let jwt = getItem("jwt");
    let serverIsOnline = await serverIsAvailable();
    if (jwt && serverIsOnline) {
        let user = await getUser(serverIsOnline, jwt);
        if (!user) {
            return;
        }
        let api = `/users/${user.id}`;
        let resp = await softwareGet(api, jwt);
        if (isResponseOk(resp)) {
            if (
                resp &&
                resp.data &&
                resp.data.data &&
                resp.data.data.preferences
            ) {
                let prefs = resp.data.data.preferences;
                let prefsShowGit =
                    prefs.showGit !== null && prefs.showGit !== undefined
                        ? prefs.showGit
                        : null;
                let prefsShowRank =
                    prefs.showRank !== null && prefs.showRank !== undefined
                        ? prefs.showRank
                        : null;

                if (prefsShowGit === null || prefsShowGit !== showGitMetrics) {
                    await sendPreferencesUpdate(parseInt(user.id, 10), prefs);
                }
            }
        }
    }
}

export function refetchUserStatusLazily(tryCountUntilFoundUser = 40) {
    if (userFetchTimeout) {
        return;
    }
    userFetchTimeout = setTimeout(() => {
        userFetchTimeout = null;
        userStatusFetchHandler(tryCountUntilFoundUser);
    }, 10000);
}

async function userStatusFetchHandler(tryCountUntilFoundUser) {
    let serverIsOnline = await serverIsAvailable();
    let userStatus = await getUserStatus(serverIsOnline, true);
    if (!userStatus.loggedIn) {
        // try again if the count is not zero
        if (tryCountUntilFoundUser > 0) {
            tryCountUntilFoundUser -= 1;
            refetchUserStatusLazily(tryCountUntilFoundUser);
        } else {
            // set the check_status to true
            setItem("check_status", true);
        }
    } else {
        clearCachedLoggedInState();

        // explicitly fetch the latest info the app server
        summaryManager.getSessionSummaryStatus(true /*forceSummaryFetch*/);

        const message = "Successfully logged on to Code Time";
        commands.executeCommand("codetime.refreshKpmTree");
        window.showInformationMessage(message);
    }
}

export async function sendHeartbeat(reason, serverIsOnline) {
    let jwt = getItem("jwt");
    if (serverIsOnline && jwt) {
        let heartbeat = {
            pluginId: getPluginId(),
            os: getOs(),
            start: nowInSecs(),
            version: getVersion(),
            hostname: await getHostname(),
            session_ctime: getSessionFileCreateTime(),
            timezone: Intl.DateTimeFormat().resolvedOptions().timeZone,
            trigger_annotation: reason,
            editor_token: getEditorSessionToken()
        };
        let api = `/data/heartbeat`;
        softwarePost(api, heartbeat, jwt).then(async resp => {
            if (!isResponseOk(resp)) {
                logIt("unable to send heartbeat ping");
            }
        });
    }
}

export async function handleKpmClickedEvent() {
    let serverIsOnline = await serverIsAvailable();
    // {loggedIn: true|false}
    let userStatus = await getUserStatus(serverIsOnline);
    let webUrl = await buildWebDashboardUrl();

    if (!userStatus.loggedIn) {
        webUrl = await buildLoginUrl();
        refetchUserStatusLazily();
    }
    launchWebUrl(webUrl);
}

export async function writeCommitSummaryData() {
    const filePath = getCommitSummaryFile();
    const serverIsOnline = await serverIsAvailable();
    if (serverIsOnline) {
        const result = await softwareGet(
            `/dashboard/commits`,
            getItem("jwt")
        ).catch(err => {
            return null;
        });
        if (isResponseOk(result) && result.data) {
            // get the string content out
            const content = result.data;
            fs.writeFileSync(filePath, content, err => {
                if (err) {
                    logIt(
                        `Error writing to the weekly commit summary content file: ${err.message}`
                    );
                }
            });
        }
    }

    if (!fs.existsSync(filePath)) {
        // just create an empty file
        fs.writeFileSync(filePath, "WEEKLY COMMIT SUMMARY", err => {
            if (err) {
                logIt(
                    `Error writing to the weekly commit summary content file: ${err.message}`
                );
            }
        });
    }
}

export async function writeCodeTimeMetricsDashboard() {
    const summaryInfoFile = getSummaryInfoFile();
    const serverIsOnline = await serverIsAvailable();

    // write the code time metrics summary to the summaryInfo file
    if (serverIsOnline) {
        let showGitMetrics = workspace.getConfiguration().get("showGitMetrics");

        let api = `/dashboard?showMusic=false&showGit=${showGitMetrics}&showRank=false&linux=${isLinux()}&showToday=false`;
        const result = await softwareGet(api, getItem("jwt"));

        if (isResponseOk(result)) {
            // get the string content out
            const content = result.data;
            fs.writeFileSync(summaryInfoFile, content, err => {
                if (err) {
                    logIt(
                        `Error writing to the code time summary content file: ${err.message}`
                    );
                }
            });
        }
    }

    // create the header
    let dashboardContent = "";
    const formattedDate = moment().format("ddd, MMM Do h:mma");
    dashboardContent = `CODE TIME          (Last updated on ${formattedDate})`;
    dashboardContent += "\n\n";

    const todayStr = moment().format("ddd, MMM Do");
    dashboardContent += getSectionHeader(`Today (${todayStr})`);

    // get the top section of the dashboard content (today's data)
    const sessionSummary = await summaryManager.getSessionSummaryStatus();
    if (sessionSummary && sessionSummary.data) {
        let averageTime = humanizeMinutes(
            sessionSummary.data.averageDailyMinutes
        );
        let hoursCodedToday = humanizeMinutes(
            sessionSummary.data.currentDayMinutes
        );
        let liveshareTime = null;
        if (sessionSummary.data.liveshareMinutes) {
            liveshareTime = humanizeMinutes(
                sessionSummary.data.liveshareMinutes
            );
        }
        dashboardContent += getDashboardRow(
            "Hours coded today",
            hoursCodedToday
        );
        dashboardContent += getDashboardRow("90-day avg", averageTime);
        if (liveshareTime) {
            dashboardContent += getDashboardRow("Live Share", liveshareTime);
        }
        dashboardContent += "\n";
    }

    // get the summary info we just made a call for and add it to the dashboard content
    if (fs.existsSync(summaryInfoFile)) {
        const summaryContent = fs.readFileSync(summaryInfoFile).toString();

        // create the dashboard file
        dashboardContent += summaryContent;
    }

    // now write it all out to the dashboard file
    const dashboardFile = getDashboardFile();
    fs.writeFileSync(dashboardFile, dashboardContent, err => {
        if (err) {
            logIt(
                `Error writing to the code time dashboard content file: ${err.message}`
            );
        }
    });
}
