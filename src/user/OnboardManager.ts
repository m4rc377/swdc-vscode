import { window, ExtensionContext } from "vscode";
import { showOfflinePrompt, setItem, getItem } from "../Util";
import { serverIsAvailable } from "../http/HttpClient";
import { createAnonymousUser } from "../menu/AccountManager";
import jwt_decode = require('jwt-decode');

let retry_counter = 0;
const one_min_millis = 1000 * 60;

export function onboardInit(ctx: ExtensionContext, callback: any) {
    let jwt = getItem("jwt");

    const windowState = window.state;

    // first, verify that it is a valid jwt token
    if (jwt && windowState.focused) {
        // it's the primary window as a secondary window
        const decoded = jwt_decode(jwt.split("JWT")[1]);
        // check to see if its an app jwt ID
        if (decoded["id"] > 9999999999) {
            // its not valid and this is the primary window, nullify it
            setItem("jwt", null);
            jwt = null;
        }
    }

    if (jwt) {
        // we have the jwt, call the callback that anon was not created
        return callback(ctx, false /*anonCreated*/);
    }

    if (windowState.focused) {
        // perform primary window related work
        primaryWindowOnboarding(ctx, callback);
    } else {
        // call the secondary onboarding logic
        secondaryWindowOnboarding(ctx, callback);
    }
}

async function primaryWindowOnboarding(ctx: ExtensionContext, callback: any) {
    let serverIsOnline = await serverIsAvailable();
    if (serverIsOnline) {
        // great, it's online, create the anon user
        const jwt = await createAnonymousUser();
        if (jwt) {
            // great, it worked. call the callback
            return callback(ctx, true /*anonCreated*/);
        }
        // else its some kind of server issue, try again in a minute
        serverIsOnline = false;
    }

    if (!serverIsOnline) {
        // not online, try again in a minute
        if (retry_counter === 0) {
            // show the prompt that we're unable connect to our app 1 time only
            showOfflinePrompt(true);
        }
        // call activate again later
        setTimeout(() => {
            retry_counter++;
            onboardInit(ctx, callback);
        }, one_min_millis * 2);
    }
}

/**
 * This is called if there's no JWT. If it reaches a
 * 6th call it will create an anon user.
 * @param ctx
 * @param callback
 */
async function secondaryWindowOnboarding(ctx: ExtensionContext, callback: any) {
    const serverIsOnline = await serverIsAvailable();
    if (!serverIsOnline) {
        // not online, try again later
        setTimeout(() => {
            onboardInit(ctx, callback);
        }, one_min_millis);
        return;
    } else if (retry_counter < 5) {
        if (serverIsOnline) {
            retry_counter++;
        }
        // call activate again in about 15 seconds
        setTimeout(() => {
            onboardInit(ctx, callback);
        }, 1000 * 15);
        return;
    }

    // tried enough times, create an anon user
    await createAnonymousUser();
    // call the callback
    return callback(ctx, true /*anonCreated*/);
}
