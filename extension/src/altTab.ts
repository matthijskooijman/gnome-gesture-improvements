import Clutter from '@gi-types/clutter';
import GLib from '@gi-types/glib';
import GObject from '@gi-types/gobject';
import Shell from '@gi-types/shell';
import Meta from '@gi-types/meta';
import { imports, global } from 'gnome-shell';

const Main = imports.ui.main;
const { WindowSwitcherPopup, AppSwitcherPopup } = imports.ui.altTab;

import { TouchpadSwipeGesture } from './swipeTracker';
import { AltTabConstants, ExtSettings } from '../constants';

let dummyWinCount = AltTabConstants.DUMMY_WIN_COUNT;

function setDummyWinCount(nelement: number): void {
	const leftOver = AltTabConstants.MIN_WIN_COUNT - nelement;
	if (leftOver > 0) {
		dummyWinCount = Math.max(AltTabConstants.DUMMY_WIN_COUNT, Math.ceil(leftOver / 2));
	}
	else {
		dummyWinCount = AltTabConstants.DUMMY_WIN_COUNT;
	}
}

function getIndexForProgress(progress: number, nelement: number): number {
	let index = Math.floor(progress * (nelement + 2 * dummyWinCount));
	index = index - dummyWinCount;
	return Math.clamp(index, 0, nelement - 1);
}

// index -> index + AltTabConstants.DUMMY_WIN_COUNT
function getAvgProgressForIndex(index: number, nelement: number): number {
	index = index + dummyWinCount;
	const progress = (index + 0.5) / (nelement + 2 * dummyWinCount);
	return progress;
}

function getGestureSpeed(nelement: number) {
	const delta = (AltTabConstants.MIN_WIN_COUNT + 2 * AltTabConstants.DUMMY_WIN_COUNT) / 64;
	return Math.clamp(1 + delta - (nelement + 2 * dummyWinCount) / 64, 0.15, 1);
}

// declare enum
enum SwitcherType {
	APP,
	WINDOW,
}

interface IAltTabSwitcher {
	selectItemForProgress(progress: number): void;
	getCurrentProgress(): number;
	open(callback: () => void): boolean;
	selectItem(open: boolean): void;
	activate(): void;
	destroy(): void;
	get kind(): SwitcherType;
	get hasItemSelected(): boolean;
	get nelements(): number;
}

// eslint-disable-next-line @typescript-eslint/no-unused-vars
const AltTabAppSwitcher = GObject.registerClass(
	class AltTabAppSwitcher extends AppSwitcherPopup implements IAltTabSwitcher {
		private _hasOpenedWindows: boolean;
		private _forceOpen?: { appIndex: number; windowIndex: number; };

		constructor() {
			super();
			this._hasOpenedWindows = false;
		}

		open(callback: () => void) {
			const canShow = super.show(false, 'switch-applications', 0);
			if (!canShow)
				return false;

			if (this._initialDelayTimeoutId !== 0) {
				GLib.source_remove(this._initialDelayTimeoutId);
				this._initialDelayTimeoutId = 0;
			}

			// get most recently used window, if gesture ended before switcher was shown, switch to mru window
			if (this._items.length > 1 && this._items[0].cachedWindows.length > 1) {
				const allWindows = global.display.get_tab_list(Meta.TabList.NORMAL, null);
				const curWinInd = allWindows.indexOf(this._items[0].cachedWindows[1]);
				const nextWinInd = allWindows.indexOf(this._items[1].cachedWindows[0]);
				if (curWinInd < nextWinInd) {
					this._forceOpen = {
						appIndex: 0,
						windowIndex: 1,
					};
				}
			}

			this._initialDelayTimeoutId = GLib.timeout_add(
				GLib.PRIORITY_DEFAULT,
				AltTabConstants.DELAY_DURATION,
				() => {
					this._forceOpen = undefined;
					callback();
					this._showImmediately();
					return GLib.SOURCE_REMOVE;
				},
			);

			setDummyWinCount(this.nelements);
			return true;
		}

		selectItemForProgress(progress: number) {
			const index = getIndexForProgress(progress, this.nelements);
			if (this._hasOpenedWindows) {
				this._select(this._selectedIndex, index);
			} else {
				this._select(index);
			}
		}

		getCurrentProgress() {
			const index = this._hasOpenedWindows ? this._currentWindow : this._selectedIndex;
			return getAvgProgressForIndex(index, this.nelements);
		}

		activate() {
			if (this._forceOpen) {
				this._selectedIndex = this._forceOpen.appIndex;
				this._currentWindow = this._forceOpen.windowIndex;
			}
			else if (!this._hasOpenedWindows && this._currentWindow < 0) {
				this._currentWindow = 0;
			}

			const win = this._items[this._selectedIndex].cachedWindows[this._currentWindow];
			Main.activateWindow(win);
		}

		selectItem(open: boolean) {
			this._hasOpenedWindows = open;
			if (open) {
				this._select(this._selectedIndex, 0, false);
				setDummyWinCount(this.nelements);
			} else {
				this._select(this._selectedIndex, undefined, true);
				setDummyWinCount(this.nelements);
			}
		}

		override _select(appIndex: number, windowIndex?: number, forceAppFocus?: boolean) {
			super._select(appIndex, windowIndex, forceAppFocus);

			const switcherLists = [];
			switcherLists.push(this._switcherList);
			if (this._thumbnails) {
				switcherLists.push(this._thumbnails);
			}

			switcherLists.forEach(switcherList => {
				const transition = switcherList._scrollView.hscroll.adjustment.get_transition('value');
				if (transition) {
					transition.advance(AltTabConstants.POPUP_SCROLL_TIME);
				}
			});
		}

		// remove timeout entirely
		override _resetNoModsTimeout() {
			if (this._noModsTimeoutId) {
				GLib.source_remove(this._noModsTimeoutId);
				this._noModsTimeoutId = 0;
			}
		}

		_keyPressHandler() {
			return Clutter.EVENT_STOP;
		}

		_timeoutPopupThumbnails() {
			this._thumbnailTimeoutId = 0;
			return GLib.SOURCE_REMOVE;
		}

		get kind() {
			return SwitcherType.WINDOW;
		}

		get hasItemSelected() {
			return this._hasOpenedWindows;
		}

		get nelements(): number {
			if (!this._hasOpenedWindows) {
				return this._items.length;
			}
			return this._items[this._selectedIndex].cachedWindows.length;
		}
	},
);

// eslint-disable-next-line @typescript-eslint/no-unused-vars
const AltTabWindowSwitcher = GObject.registerClass(
	class AltTabWindowSwitcher extends WindowSwitcherPopup implements IAltTabSwitcher {
		constructor() {
			super();
		}

		selectItemForProgress(progress: number) {
			const index = getIndexForProgress(progress, this.nelements);
			this._select(index);

			const adjustment = this._switcherList._scrollView.hscroll.adjustment;
			const transition = adjustment.get_transition('value');
			if (transition) {
				transition.advance(AltTabConstants.POPUP_SCROLL_TIME);
			}
		}

		getCurrentProgress() {
			return getAvgProgressForIndex(this._selectedIndex, this.nelements);
		}

		activate() {
			const win = this._items[this._selectedIndex].window;
			Main.activateWindow(win);
		}

		open(callback: () => void) {
			const canShow = super.show(false, 'switch-windows', 0);
			if (!canShow)
				return false;

			if (this._initialDelayTimeoutId !== 0) {
				GLib.source_remove(this._initialDelayTimeoutId);
				this._initialDelayTimeoutId = 0;
			}

			this._initialDelayTimeoutId = GLib.timeout_add(
				GLib.PRIORITY_DEFAULT,
				AltTabConstants.DELAY_DURATION,
				() => {
					callback();
					this._showImmediately();
					return GLib.SOURCE_REMOVE;
				},
			);

			setDummyWinCount(this.nelements);

			return true;
		}

		// eslint-disable-next-line @typescript-eslint/no-empty-function
		selectItem(_open: never) { }

		_keyPressHandler() {
			return Clutter.EVENT_STOP;
		}

		// remove timeout entirely
		override _resetNoModsTimeout() {
			if (this._noModsTimeoutId) {
				GLib.source_remove(this._noModsTimeoutId);
				this._noModsTimeoutId = 0;
			}
		}

		get kind() {
			return SwitcherType.WINDOW;
		}

		get hasItemSelected() {
			return false;
		}

		get nelements(): number {
			return this._items.length;
		}
	},
);

// declare enum
enum AltTabExtState {
	DISABLED = 0,
	DEFAULT = 1,
	ALTTABDELAY = 2,
	ALTTAB = 3,
}

export class AltTabGestureExtension implements ISubExtension {
	private _connectHandlers: number[];
	private _touchpadSwipeTracker: typeof TouchpadSwipeGesture.prototype;
	private _switcher?: IAltTabSwitcher;
	private _extState = AltTabExtState.DISABLED;
	private _progress = 0;
	private _altTabTimeoutId = 0;

	constructor() {
		this._connectHandlers = [];

		this._touchpadSwipeTracker = new TouchpadSwipeGesture(
			(ExtSettings.DEFAULT_SESSION_WORKSPACE_GESTURE ? [4] : [3]),
			Shell.ActionMode.ALL,
			Clutter.Orientation.HORIZONTAL,
			false,
			this._checkAllowedGesture.bind(this),
		);
		this._touchpadSwipeTracker.setAutoSwitchDirection(true, true, 1);
	}

	_checkAllowedGesture(): boolean {
		return this._extState <= AltTabExtState.DEFAULT && Main.actionMode === Shell.ActionMode.NORMAL;
	}

	apply(): void {
		this._connectHandlers.push(this._touchpadSwipeTracker.connect('begin', this._gestureBegin.bind(this)));
		this._connectHandlers.push(this._touchpadSwipeTracker.connect('update', this._gestureUpdate.bind(this)));
		this._connectHandlers.push(this._touchpadSwipeTracker.connect('end', this._gestureEnd.bind(this)));
		this._extState = AltTabExtState.DEFAULT;
	}

	destroy(): void {
		this._extState = AltTabExtState.DISABLED;
		this._connectHandlers.forEach(handle => this._touchpadSwipeTracker.disconnect(handle));

		this._touchpadSwipeTracker.destroy();
		this._connectHandlers = [];

		if (this._switcher) {
			this._switcher.destroy();
			this._switcher = undefined;
		}
	}

	_gestureBegin(): void {
		this._progress = 0;
		if (this._extState === AltTabExtState.DEFAULT) {
			this._switcher = new AltTabAppSwitcher();
			this._touchpadSwipeTracker.setAutoSwitchDirection(true, true, getGestureSpeed(this._switcher.nelements));

			if (this._switcher.open(() => {
				this._extState = AltTabExtState.ALTTAB;
				if (this._switcher)
					this._progress = this._switcher.getCurrentProgress();
			})) {
				this._progress = this._switcher.getCurrentProgress();
				this._extState = AltTabExtState.ALTTABDELAY;
			}
			else {
				this._switcher.destroy();
				this._switcher = undefined;
			}
		}
	}

	_gestureUpdate(_gesture: never, _time: never, delta: number, distance: number, direction: Clutter.Orientation): void {
		if (this._extState === AltTabExtState.ALTTAB && this._switcher) {
			if (direction === Clutter.Orientation.HORIZONTAL) {
				this._progress = Math.clamp(this._progress + delta / distance, 0, 1);
				this._switcher.selectItemForProgress(this._progress);
			}
			else {
				const hasItemSelected = this._switcher.hasItemSelected;
				this._switcher.selectItem(!hasItemSelected);
				this._touchpadSwipeTracker.setAutoSwitchDirection(true, hasItemSelected, getGestureSpeed(this._switcher.nelements));
				this._progress = this._switcher.getCurrentProgress();
			}
		}
	}

	_gestureEnd(): void {
		if (this._extState === AltTabExtState.ALTTAB ||
			this._extState === AltTabExtState.ALTTABDELAY) {
			this._extState = AltTabExtState.DEFAULT;
			if (this._altTabTimeoutId != 0) {
				GLib.source_remove(this._altTabTimeoutId);
				this._altTabTimeoutId = 0;
			}

			if (this._switcher) {
				this._switcher.activate();
				this._switcher.destroy();
				this._switcher = undefined;
			}

			this._progress = 0;
		}
		this._extState = AltTabExtState.DEFAULT;
	}
}