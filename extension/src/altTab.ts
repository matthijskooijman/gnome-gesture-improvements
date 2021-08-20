import Clutter from '@gi-types/clutter';
import GLib from '@gi-types/glib';
import GObject from '@gi-types/gobject';
import Shell from '@gi-types/shell';
import { imports } from 'gnome-shell';

const Main = imports.ui.main;
const { WindowSwitcherPopup, AppSwitcherPopup } = imports.ui.altTab;

import { TouchpadSwipeTracker, ITouchpadSwipeKlassConstructorProperties, GestureDirection } from './swipeTracker';
import { AltTabConstants, ExtSettings, TouchpadConstants } from '../constants';

let dummyWinCount = AltTabConstants.DUMMY_WIN_COUNT;
const AltTabAppSwitcherThumbnails_CThreshold = TouchpadConstants.SWITCH_DIRECTION_THRESHOLD_DISTANCE / TouchpadConstants.TOUCHPAD_BASE_WIDTH;

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
	open(direction?: GestureDirection): boolean;
	showImmediately(): void;
	selectItem?(open: boolean): void;
	activate(): void;
	destroy(): void;
	kind: SwitcherType;
	hasItemSelected?: boolean;
	nelements: number;
}

// eslint-disable-next-line @typescript-eslint/no-unused-vars
const AltTabAppSwitcher = GObject.registerClass(
	class AltTabAppSwitcher extends AppSwitcherPopup implements IAltTabSwitcher {
		private _hasOpenedWindows: boolean;

		constructor() {
			super();
			this._hasOpenedWindows = false;
		}

		open(direction?: GestureDirection) {
			const canShow = super.show(false, 'switch-applications', 0);
			if (!canShow)
				return false;

			if (this._initialDelayTimeoutId !== 0) {
				GLib.source_remove(this._initialDelayTimeoutId);
				this._initialDelayTimeoutId = 0;
			}

			if (direction === GestureDirection.LEFT) {
				this._select(0);
			}

			setDummyWinCount(this.nelements);
			return true;
		}

		showImmediately() {
			Main.osdWindowManager.hideAll();
			this.opacity = 255;
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
			if (!this._hasOpenedWindows && this._currentWindow < 0) {
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

		open(direction?: GestureDirection) {
			const canShow = super.show(false, 'switch-windows', 0);
			if (!canShow)
				return false;

			if (this._initialDelayTimeoutId !== 0) {
				GLib.source_remove(this._initialDelayTimeoutId);
				this._initialDelayTimeoutId = 0;
			}

			if (direction === GestureDirection.LEFT) {
				this._select(0);
			}

			setDummyWinCount(this.nelements);
			return true;
		}

		showImmediately() {
			Main.osdWindowManager.hideAll();
			this.opacity = 255;
		}

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
	private _touchpadSwipeTrackers: {
		tracker: typeof TouchpadSwipeTracker.prototype,
		direction: GestureDirection,
		ids: number[]
	}[] = [];

	private _switcher?: IAltTabSwitcher;
	private _extState = AltTabExtState.DISABLED;
	private _progress = 0;
	private _altTabTimeoutId = 0;
	private _cumulativeDirection = GestureDirection.RIGHT;
	private _cumulativeProgress = 0;

	constructor() {
		this._bindTouchpadTracker(SwitcherType.WINDOW, GestureDirection.RIGHT);
		this._bindTouchpadTracker(SwitcherType.APP, GestureDirection.LEFT);
		this._extState = AltTabExtState.DEFAULT;
	}

	_bindTouchpadTracker(kind: SwitcherType, triggerDirection: GestureDirection): void {
		const touchpadSwipeTracker = new TouchpadSwipeTracker({
			nfingers: (ExtSettings.DEFAULT_SESSION_WORKSPACE_GESTURE ? [4] : [3]),
			allowedModes: Shell.ActionMode.ALL,
			triggerDirections: [triggerDirection],
			checkAllowedGesture: this._checkAllowedGesture.bind(this),
			gestureSpeed: 1,
		} as ITouchpadSwipeKlassConstructorProperties);

		const beginFunc = kind === SwitcherType.APP ? this._gestureBeginApp : this._gestureBeginWindow;
		this._touchpadSwipeTrackers.push({
			tracker: touchpadSwipeTracker,
			direction: triggerDirection,
			ids: [
				touchpadSwipeTracker.connect('begin', beginFunc.bind(this)),
				touchpadSwipeTracker.connect('update', this._gestureUpdate.bind(this)),
				touchpadSwipeTracker.connect('end', this._gestureEnd.bind(this)),
			],
		});
	}

	_checkAllowedGesture(): boolean {
		return this._extState <= AltTabExtState.DEFAULT && Main.actionMode === Shell.ActionMode.NORMAL;
	}

	destroy(): void {
		this._extState = AltTabExtState.DISABLED;
		this._touchpadSwipeTrackers.forEach(swipeTracker => {
			swipeTracker.ids.forEach(id => swipeTracker.tracker.disconnect(id));
			swipeTracker.tracker.destroy();
		});

		this._touchpadSwipeTrackers = [];

		if (this._switcher) {
			this._switcher.destroy();
			this._switcher = undefined;
		}
	}

	_gestureBeginApp(swipeTracker: typeof TouchpadSwipeTracker.prototype): void {
		if (this._extState === AltTabExtState.DEFAULT) {
			this._switcher = new AltTabAppSwitcher();
			this._gestureBegin(swipeTracker);
		}
	}

	_gestureBeginWindow(swipeTracker: typeof TouchpadSwipeTracker.prototype): void {
		this._progress = 0;
		if (this._extState === AltTabExtState.DEFAULT) {
			this._switcher = new AltTabWindowSwitcher();
			this._gestureBegin(swipeTracker);
		}
	}

	_gestureBegin(swipeTracker: typeof TouchpadSwipeTracker.prototype): void {
		if (this._extState === AltTabExtState.DEFAULT && this._switcher) {
			swipeTracker.setGestureSpeed(getGestureSpeed(this._switcher.nelements));
			const direction = this._touchpadSwipeTrackers.find(st => st.tracker === swipeTracker)?.direction;
			if (this._switcher.open(direction)) {
				this._altTabTimeoutId = GLib.timeout_add(
					GLib.PRIORITY_DEFAULT,
					AltTabConstants.DELAY_DURATION,
					() => {
						if (this._switcher) {
							this._progress = this._switcher.getCurrentProgress();
							this._switcher.showImmediately();
						}

						this._extState = AltTabExtState.ALTTAB;
						this._altTabTimeoutId = 0;
						return GLib.SOURCE_REMOVE;
					},
				);
				this._progress = this._switcher.getCurrentProgress();
				this._extState = AltTabExtState.ALTTABDELAY;
			}
			else {
				this._switcher.destroy();
				this._switcher = undefined;
			}
		}
	}

	_gestureUpdate(swipeTracker: typeof TouchpadSwipeTracker.prototype, _time: never, delta: number, distance: number, direction: GestureDirection): void {
		if (this._cumulativeDirection !== direction) {
			this._cumulativeProgress = 0;
			this._cumulativeDirection = direction;
		}
		this._cumulativeProgress = Math.clamp(this._cumulativeProgress + Math.abs(delta) / distance, 0, 1);

		if (this._extState === AltTabExtState.ALTTAB && this._switcher) {
			let expctedHasItemSelected: boolean;
			switch (direction) {
				case GestureDirection.LEFT:
				case GestureDirection.RIGHT:
					this._progress = Math.clamp(this._progress + delta / distance, 0, 1);
					this._switcher.selectItemForProgress(this._progress);
					break;
				case GestureDirection.DOWN:
				case GestureDirection.UP:
					expctedHasItemSelected = direction === GestureDirection.UP;
					if (this._switcher.hasItemSelected === expctedHasItemSelected && this._cumulativeProgress >= AltTabAppSwitcherThumbnails_CThreshold && this._switcher.selectItem) {
						this._switcher.selectItem(!expctedHasItemSelected);
						this._progress = this._switcher.getCurrentProgress();
						swipeTracker.setGestureSpeed(getGestureSpeed(this._switcher.nelements));
						this._cumulativeProgress = 0;
					}
					break;
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