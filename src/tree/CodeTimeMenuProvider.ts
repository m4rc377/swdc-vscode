import {
    TreeDataProvider,
    TreeItemCollapsibleState,
    EventEmitter,
    Event,
    TreeView,
    Disposable
} from "vscode";
import { KpmItem } from "../model/models";
import {
    KpmProviderManager,
    KpmTreeItem,
    handleKpmChangeSelection
} from "./KpmProviderManager";
import { logIt } from "../Util";

const kpmProviderMgr: KpmProviderManager = KpmProviderManager.getInstance();

const codetimeCollapsedStateMap = {};

export const connectCodeTimeMenuTreeView = (view: TreeView<KpmItem>) => {
    return Disposable.from(
        view.onDidCollapseElement(async e => {
            const item: KpmItem = e.element;
            codetimeCollapsedStateMap[item.label] =
                TreeItemCollapsibleState.Collapsed;
        }),

        view.onDidExpandElement(async e => {
            const item: KpmItem = e.element;
            codetimeCollapsedStateMap[item.label] =
                TreeItemCollapsibleState.Expanded;
        }),

        view.onDidChangeSelection(async e => {
            if (!e.selection || e.selection.length === 0) {
                return;
            }

            const item: KpmItem = e.selection[0];

            handleKpmChangeSelection(view, item);
        }),
        view.onDidChangeVisibility(e => {
            if (e.visible) {
                //
            }
        })
    );
};

export class CodeTimeMenuProvider implements TreeDataProvider<KpmItem> {
    private _onDidChangeTreeData: EventEmitter<
        KpmItem | undefined
    > = new EventEmitter<KpmItem | undefined>();

    readonly onDidChangeTreeData: Event<KpmItem | undefined> = this
        ._onDidChangeTreeData.event;

    private view: TreeView<KpmItem>;
    private initializedTree: boolean = false;

    constructor() {
        //
    }

    async revealTree() {
        if (!this.initializedTree) {
            await this.refresh();
        }

        const item: KpmItem = KpmProviderManager.getInstance().getCodeTimeDashboardButton();
        try {
            // select the readme item
            this.view.reveal(item, {
                focus: true,
                select: false
            });
        } catch (err) {
            logIt(`Unable to select tree item: ${err.message}`);
        }
    }

    bindView(kpmTreeView: TreeView<KpmItem>): void {
        this.view = kpmTreeView;
    }

    getParent(_p: KpmItem) {
        return void 0; // all playlists are in root
    }

    refresh(): void {
        this._onDidChangeTreeData.fire(null);
    }

    refreshParent(parent: KpmItem) {
        this._onDidChangeTreeData.fire(parent);
    }

    getTreeItem(p: KpmItem): KpmTreeItem {
        let treeItem: KpmTreeItem = null;
        if (p.children.length) {
            let collasibleState = codetimeCollapsedStateMap[p.label];
            if (!collasibleState) {
                treeItem = createKpmTreeItem(
                    p,
                    TreeItemCollapsibleState.Collapsed
                );
            } else {
                treeItem = createKpmTreeItem(p, collasibleState);
            }
        } else {
            treeItem = createKpmTreeItem(p, TreeItemCollapsibleState.None);
            this.initializedTree = true;
        }

        return treeItem;
    }

    async getChildren(element?: KpmItem): Promise<KpmItem[]> {
        let kpmItems: KpmItem[] = [];
        if (element) {
            // return the children of this element
            kpmItems = element.children;
        } else {
            // return the parent elements
            kpmItems = await kpmProviderMgr.getOptionsTreeParents();
        }
        return kpmItems;
    }
}

/**
 * Create the playlist tree item (root or leaf)
 * @param p
 * @param cstate
 */
function createKpmTreeItem(p: KpmItem, cstate: TreeItemCollapsibleState) {
    return new KpmTreeItem(p, cstate);
}
