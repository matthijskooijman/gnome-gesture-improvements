import Clutter from '@gi-types/clutter';
import GObject from '@gi-types/gobject';
import Shell from '@gi-types/shell';
import Meta from '@gi-types/meta';
import { imports, global, CustomEventType } from 'gnome-shell';

const Main = imports.ui.main;
const { SwipeTracker } = imports.ui.swipeTracker;

import * as DBusUtils from './utils/dbus';
import { TouchpadConstants } from '../constants';

// define enum
enum TouchpadState {
	NONE = 0,
	PENDING = 1,
	HANDLING = 2,
	IGNORED = 3,
}

export const TouchpadSwipeGesture = GObject.registerClass({
	Properties: {
		'enabled': GObject.ParamSpec.boolean(
			'enabled',
			'enabled',
			'enabled',
			GObject.ParamFlags.READWRITE,
			true,
		),
		'orientation': GObject.ParamSpec.enum(
			'orientation',
			'orientation',
			'orientation',
			GObject.ParamFlags.READWRITE,
			Clutter.Orientation,
			Clutter.Orientation.HORIZONTAL,
		),
	},
	Signals: {
		'begin': { param_types: [GObject.TYPE_UINT, GObject.TYPE_DOUBLE, GObject.TYPE_DOUBLE] },
		'update': { param_types: [GObject.TYPE_UINT, GObject.TYPE_DOUBLE, GObject.TYPE_DOUBLE, GObject.TYPE_UINT] },
		'end': { param_types: [GObject.TYPE_UINT, GObject.TYPE_DOUBLE] },
	},
}, class TouchpadSwipeGesture extends GObject.Object {
	private _nfingers: number[];
	private _allowedModes: Shell.ActionMode;
	orientation: Clutter.Orientation;
	private _state: TouchpadState;
	private _checkAllowedGesture?: (event: CustomEventType) => boolean;
	private _cumulativeX = 0;
	private _cumulativeY = 0;
	private _followNaturalScroll: boolean;
	private _toggledDirection = false;
	private _autoSwitchDirection = false;
	private _autodirection: Clutter.Orientation;
	private _autoSwitchPositive: boolean | undefined;
	_stageCaptureEvent = 0;
	SWIPE_MULTIPLIER: number;
	TOUCHPAD_BASE_HEIGHT = TouchpadConstants.TOUCHPAD_BASE_HEIGHT;
	TOUCHPAD_BASE_WIDTH = TouchpadConstants.TOUCHPAD_BASE_WIDTH;
	DRAG_THRESHOLD_DISTANCE = TouchpadConstants.DRAG_THRESHOLD_DISTANCE;
	enabled = true;

	constructor(
		nfingers: number[],
		allowedModes: Shell.ActionMode,
		orientation: Clutter.Orientation,
		followNaturalScroll = true,
		checkAllowedGesture = undefined,
		gestureSpeed = 1.0,
	) {
		super();
		this._nfingers = nfingers;
		this._allowedModes = allowedModes;
		this.orientation = orientation;
		this._autodirection = orientation;
		this._state = TouchpadState.NONE;
		this._checkAllowedGesture = checkAllowedGesture;
		this._followNaturalScroll = followNaturalScroll;
		if (Meta.is_wayland_compositor()) {
			this._stageCaptureEvent = global.stage.connect('captured-event::touchpad', this._handleEvent.bind(this));
		} else {
			DBusUtils.subscribe(this._handleEvent.bind(this));
		}

		this.SWIPE_MULTIPLIER = TouchpadConstants.SWIPE_MULTIPLIER * (typeof (gestureSpeed) !== 'number' ? 1.0 : gestureSpeed);
	}

	_handleEvent(_actor: undefined | Clutter.Actor, event: CustomEventType): boolean {
		if (event.type() !== Clutter.EventType.TOUCHPAD_SWIPE)
			return Clutter.EVENT_PROPAGATE;

		const gesturePhase = event.get_gesture_phase();
		if (gesturePhase === Clutter.TouchpadGesturePhase.BEGIN) {
			this._state = TouchpadState.NONE;
			this._toggledDirection = false;
			this._autoSwitchDirection = false;
			this._autodirection = this.orientation;
		}

		if (this._state === TouchpadState.IGNORED)
			return Clutter.EVENT_PROPAGATE;

		if (!this.enabled)
			return Clutter.EVENT_PROPAGATE;

		if ((this._allowedModes !== Shell.ActionMode.ALL) && ((this._allowedModes & Main.actionMode) === 0)) {
			this._state = TouchpadState.IGNORED;
			return Clutter.EVENT_PROPAGATE;
		}

		if (!this._nfingers.includes(event.get_touchpad_gesture_finger_count())) {
			this._state = TouchpadState.IGNORED;
			return Clutter.EVENT_PROPAGATE;
		}

		if (gesturePhase === Clutter.TouchpadGesturePhase.BEGIN && this._checkAllowedGesture !== undefined) {
			try {
				if (this._checkAllowedGesture(event) !== true) {
					this._state = TouchpadState.IGNORED;
					return Clutter.EVENT_PROPAGATE;
				}
			}
			catch (ex) {
				this._state = TouchpadState.IGNORED;
				return Clutter.EVENT_PROPAGATE;
			}
		}

		const time = event.get_time();

		const [x, y] = event.get_coords();
		const [dx, dy] = event.get_gesture_motion_delta_unaccelerated();

		if (this._state === TouchpadState.NONE) {
			if (dx === 0 && dy === 0)
				return Clutter.EVENT_PROPAGATE;

			this._cumulativeX = 0;
			this._cumulativeY = 0;
			this._state = TouchpadState.PENDING;
		}

		if (this._state === TouchpadState.PENDING) {
			this._cumulativeX += dx * this.SWIPE_MULTIPLIER;
			this._cumulativeY += dy * this.SWIPE_MULTIPLIER;

			const cdx = this._cumulativeX;
			const cdy = this._cumulativeY;
			const distance = Math.sqrt(cdx * cdx + cdy * cdy);

			if (distance >= this.DRAG_THRESHOLD_DISTANCE) {
				const gestureOrientation = Math.abs(cdx) > Math.abs(cdy)
					? Clutter.Orientation.HORIZONTAL
					: Clutter.Orientation.VERTICAL;

				this._cumulativeX = 0;
				this._cumulativeY = 0;

				if (gestureOrientation === this.orientation) {
					this._state = TouchpadState.HANDLING;
					this.emit('begin', time, x, y);
					return Clutter.EVENT_STOP;
				} else {
					this._state = TouchpadState.IGNORED;
					return Clutter.EVENT_PROPAGATE;
				}
			} else {
				return Clutter.EVENT_PROPAGATE;
			}
		}

		if (this._autoSwitchDirection) {
			this._cumulativeX += dx * this.SWIPE_MULTIPLIER;
			this._cumulativeY += dy * this.SWIPE_MULTIPLIER;

			const cdx = this._cumulativeX;
			const cdy = this._cumulativeY;
			const distance = Math.sqrt(cdx * cdx + cdy * cdy);

			if (distance >= TouchpadConstants.SWITCH_DIRECTION_THRESHOLD_DISTANCE) {
				this._setAutoDirection(cdx, cdy);
				this._cumulativeX = 0;
				this._cumulativeY = 0;
			}
		}

		const vertical = this._autodirection === Clutter.Orientation.VERTICAL;
		let delta = ((vertical !== this._toggledDirection) ? dy : dx) * this.SWIPE_MULTIPLIER;
		const distance = vertical ? this.TOUCHPAD_BASE_HEIGHT : this.TOUCHPAD_BASE_WIDTH;

		switch (gesturePhase) {
			case Clutter.TouchpadGesturePhase.BEGIN:
			case Clutter.TouchpadGesturePhase.UPDATE:
				if (this._followNaturalScroll)
					delta = -delta;

				this.emit('update', time, delta, distance, this._autodirection);
				break;

			case Clutter.TouchpadGesturePhase.END:
			case Clutter.TouchpadGesturePhase.CANCEL:
				this.emit('end', time, distance);
				this._state = TouchpadState.NONE;
				this._toggledDirection = false;
				this._autoSwitchDirection = false;
				this._autodirection = this.orientation;
				return Clutter.EVENT_STOP;
		}

		return this._state === TouchpadState.HANDLING
			? Clutter.EVENT_STOP
			: Clutter.EVENT_PROPAGATE;
	}

	private _setAutoDirection(cdx: number, cdy: number) {
		// is gesture positive or negative
		const absCdxoy = Math.max(Math.abs(cdx), Math.abs(cdy));
		let canSwitchDirection = true;
		if (this._autoSwitchPositive === true) {
			canSwitchDirection = absCdxoy === Math.max(cdx, cdy);
		}
		else if (this._autoSwitchPositive === false) {
			canSwitchDirection = absCdxoy === Math.max(-cdx, -cdy);
		}

		if (canSwitchDirection && this._autoSwitchDirection) {
			this._autodirection = Math.abs(cdx) > Math.abs(cdy)
				? Clutter.Orientation.HORIZONTAL
				: Clutter.Orientation.VERTICAL;
		}
	}

	switchDirectionTo(direction: Clutter.Orientation): void {
		if (this._state !== TouchpadState.HANDLING) {
			return;
		}

		this._toggledDirection = direction !== this.orientation;
	}

	public setAutoSwitchDirection(autoSwitch: boolean, positive: boolean, gestureSpeed?: number) {
		this._autodirection = this.orientation;
		this._autoSwitchDirection = autoSwitch;
		this._autoSwitchPositive = positive;
		this.SWIPE_MULTIPLIER = gestureSpeed !== undefined ? TouchpadConstants.SWIPE_MULTIPLIER * gestureSpeed : this.SWIPE_MULTIPLIER;
	}

	destroy() {
		if (this._stageCaptureEvent) {
			global.stage.disconnect(this._stageCaptureEvent);
			this._stageCaptureEvent = 0;
		}
	}
});

declare type _SwipeTrackerOptionalParams = {
	allowTouch?: boolean,
	allowDrag?: boolean,
	allowScroll?: boolean,
}

export function createSwipeTracker(
	actor: Clutter.Actor,
	nfingers: number[],
	allowedModes: Shell.ActionMode,
	orientation: Clutter.Orientation,
	gestureSpeed = 1,
	params?: _SwipeTrackerOptionalParams,
): typeof SwipeTracker.prototype {

	params = params ?? {};
	params.allowDrag = params.allowDrag ?? false;
	params.allowScroll = params.allowScroll ?? false;
	const allowTouch = params.allowTouch ?? true;
	delete params.allowTouch;

	// create swipeTracker
	const swipeTracker = new SwipeTracker(
		actor,
		orientation,
		allowedModes,
		params,
	);

	// remove touch gestures
	if (!allowTouch && swipeTracker._touchGesture) {
		global.stage.remove_action(swipeTracker._touchGesture);
		delete swipeTracker._touchGesture;
	}

	// remove old touchpad gesture from swipeTracker
	if (swipeTracker._touchpadGesture) {
		swipeTracker._touchpadGesture.destroy();
		swipeTracker._touchpadGesture = undefined;
	}

	// add touchpadBindings to tracker
	swipeTracker._touchpadGesture = new TouchpadSwipeGesture(
		nfingers,
		swipeTracker._allowedModes,
		swipeTracker.orientation,
		true,
		undefined,
		gestureSpeed,
	);
	swipeTracker._touchpadGesture.connect('begin', swipeTracker._beginGesture.bind(swipeTracker));
	swipeTracker._touchpadGesture.connect('update', swipeTracker._updateGesture.bind(swipeTracker));
	swipeTracker._touchpadGesture.connect('end', swipeTracker._endTouchpadGesture.bind(swipeTracker));
	swipeTracker.bind_property('enabled', swipeTracker._touchpadGesture, 'enabled', 0);
	swipeTracker.bind_property(
		'orientation',
		swipeTracker._touchpadGesture,
		'orientation',
		GObject.BindingFlags.SYNC_CREATE,
	);
	return swipeTracker;
}