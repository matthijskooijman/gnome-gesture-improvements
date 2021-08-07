/* exported PatchExtension */

// eslint-disable-next-line no-unused-vars
const { Meta, GLib, Clutter, Shell } = imports.gi;

const Main = imports.ui.main;
const { Overview } = imports.ui.overview;
const { ControlsManager } = imports.ui.overviewControls;
const { WorkspacesView } = imports.ui.workspacesView;
const OverviewControls = imports.ui.overviewControls;

const Me = imports.misc.extensionUtils.getCurrentExtension();
const Workspace = Me.imports.src.patches.workspace;

function Patched_WorkspaceView_UpdateWorkspaces() {
	let workspaceManager = global.workspace_manager;
	let newNumWorkspaces = workspaceManager.n_workspaces;

	for (let j = 0; j < newNumWorkspaces; j++) {
		let metaWorkspace = workspaceManager.get_workspace_by_index(j);
		let workspace;

		if (j >= this._workspaces.length) { /* added */
			workspace = new Workspace.Workspace(
				metaWorkspace,
				this._monitorIndex,
				this._overviewAdjustment
			);
			this.add_actor(workspace);
			this._workspaces[j] = workspace;
		} else {
			workspace = this._workspaces[j];

			if (workspace.metaWorkspace != metaWorkspace) { /* removed */
				workspace.destroy();
				this._workspaces.splice(j, 1);
			} /* else kept */
		}
	}

	for (let j = this._workspaces.length - 1; j >= newNumWorkspaces; j--) {
		this._workspaces[j].destroy();
		this._workspaces.splice(j, 1);
	}

	this._updateWorkspacesState();
}

function Patched_OverviewControl_AppDisplayVisibility(stateTransitionParams = null) {
	if (!stateTransitionParams)
		stateTransitionParams = this._stateAdjustment.getStateTransitionParams();

	const { initialState, finalState } = stateTransitionParams;
	const state = Math.max(initialState, finalState);

	this._appDisplay.visible =
		state > OverviewControls.ControlsState.WINDOW_PICKER &&
		!this._searchController.searchActive;
}

function Overview_gestureBegin(tracker) {
	this._overview.controls._stateAdjustment.remove_transition('value');

	const wasShown = this._shown;
	if (!wasShown) {
		this._shown = true;
		this._syncGrab();
		Main.layoutManager.showOverview();

		this._visible = true;
		this._animationInProgress = true;
		this._visibleTarget = true;
		Meta.disable_unredirect_for_display(global.display);
	}

	this._overview.controls.gestureBegin(tracker);

	if (!wasShown) {
		Main.layoutManager.overviewGroup.set_child_above_sibling(this._coverPane, null);
		this._coverPane.show();
		this.emit('showing');
	}
}

var PatchExtension = class PatchExtension {
	constructor() {
		this._classeToPatch = [
			{
				'GObjectClass': WorkspacesView,
				'functionName': '_updateWorkspaces',
				'patchedFunction': Patched_WorkspaceView_UpdateWorkspaces,
				'unPatchedFunction': null
			},
			{
				'GObjectClass': ControlsManager,
				'functionName': '_updateAppDisplayVisibility',
				'patchedFunction': Patched_OverviewControl_AppDisplayVisibility,
				'unPatchedFunction': null
			},
			{
				'GObjectClass': Overview,
				'functionName': '_gestureBegin',
				'patchedFunction': Overview_gestureBegin,
				'unPatchedFunction': null
			}
		];

		this._classeToPatch.forEach(entry => {
			const { 'GObjectClass': classGObj, functionName } = entry;
			entry.unPatchedFunction = classGObj.prototype[functionName];
		});
	}

	apply() {
		this._classeToPatch.forEach(entry => {
			const { 'GObjectClass': classGObj, functionName, patchedFunction } = entry;
			classGObj.prototype[functionName] = patchedFunction;
		});
	}

	destroy() {
		this._classeToPatch.reverse().forEach(entry => {
			const { 'GObjectClass': classGObj, functionName, unPatchedFunction } = entry;
			classGObj.prototype[functionName] = unPatchedFunction;
		});
	}
};