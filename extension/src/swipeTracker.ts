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

// define enum
export enum GestureDirection {
	LEFT,
	RIGHT,
	UP,
	DOWN,
}

export interface ITouchpadSwipeKlassConstructorProperties {
	nfingers: number[],
	allowedModes: Shell.ActionMode,
	triggerDirections: GestureDirection[],
	checkAllowedGesture?: (event: CustomEventType) => boolean,
	gestureSpeed?: number,
}

// this is for actual use
export const TouchpadSwipeTracker = GObject.registerClass({
	Signals: {
		'begin': { param_types: [GObject.TYPE_UINT, GObject.TYPE_DOUBLE, GObject.TYPE_DOUBLE, GObject.TYPE_INT] },
		'update': { param_types: [GObject.TYPE_UINT, GObject.TYPE_DOUBLE, GObject.TYPE_DOUBLE, GObject.TYPE_UINT] },
		'end': { param_types: [GObject.TYPE_UINT, GObject.TYPE_DOUBLE, GObject.TYPE_UINT] },
	},
}, class TouchpadSwipeTracker extends GObject.Object {
	private _nfingers: number[];
	private _allowedModes: Shell.ActionMode;
	private _triggerDirections: GestureDirection[];
	private _checkAllowedGesture: ITouchpadSwipeKlassConstructorProperties['checkAllowedGesture'];

	protected _state = TouchpadState.NONE;
	protected _previousDirection: GestureDirection;

	_stageCaptureEvent = 0;
	enabled = true;
	SWIPE_MULTIPLIER: number;

	private _cumulativeX = 0;
	private _cumulativeY = 0;

	constructor(params: ITouchpadSwipeKlassConstructorProperties) {
		super();
		params.gestureSpeed = params.gestureSpeed ?? 1.0;

		this._nfingers = params.nfingers;
		this._allowedModes = params.allowedModes;
		this._triggerDirections = params.triggerDirections;
		this._previousDirection = this._triggerDirections[0];

		this._checkAllowedGesture = params.checkAllowedGesture;

		this.SWIPE_MULTIPLIER = params.gestureSpeed * TouchpadConstants.SWIPE_MULTIPLIER;

		if (Meta.is_wayland_compositor()) {
			this._stageCaptureEvent = global.stage.connect('captured-event::touchpad', this._handleEvent.bind(this));
		} else {
			DBusUtils.subscribe(this._handleEvent.bind(this));
		}
	}

	destroy() {
		if (this._stageCaptureEvent) {
			global.stage.disconnect(this._stageCaptureEvent);
			this._stageCaptureEvent = 0;
		}
	}

	setGestureSpeed(speed: number) {
		this.SWIPE_MULTIPLIER = speed * TouchpadConstants.SWIPE_MULTIPLIER;
	}

	_handleEvent(_actor: Clutter.Actor | undefined, event: CustomEventType) {
		if (event.type() !== Clutter.EventType.TOUCHPAD_SWIPE)
			return Clutter.EVENT_PROPAGATE;

		const gesturePhase = event.get_gesture_phase();
		if (gesturePhase === Clutter.TouchpadGesturePhase.BEGIN) {
			this._state = TouchpadState.NONE;
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

		switch (this._state) {
			case TouchpadState.NONE:
			case TouchpadState.PENDING:
				return this._checkTrigger(event);
			case TouchpadState.HANDLING:
				return this._processEvent(event);
		}
	}

	private _checkTrigger(event: CustomEventType) {
		const time = event.get_time();

		const [x, y] = event.get_coords();
		const [dx, dy] = event.get_gesture_motion_delta_unaccelerated();

		if (this._state === TouchpadState.NONE) {
			if (dx === 0 && dy === 0)
				return Clutter.EVENT_PROPAGATE;

			this._cumulativeX = 0;
			this._cumulativeY = 0;
			this._state = TouchpadState.PENDING;
			return Clutter.EVENT_PROPAGATE;
		}

		const gestureDirection = this._getCumulativeDirection(dx, dy);
		if (gestureDirection !== undefined) {
			if (this._triggerDirections.includes(gestureDirection)) {
				this._state = TouchpadState.HANDLING;
				this._previousDirection = gestureDirection;
				this.emit('begin', time, x, y, gestureDirection);
				return Clutter.EVENT_STOP;
			}
			else {
				this._state = TouchpadState.IGNORED;
			}
		}

		return Clutter.EVENT_PROPAGATE;
	}


	private _processEvent(event: CustomEventType) {
		// handling
		const time = event.get_time();

		const [dx, dy] = event.get_gesture_motion_delta_unaccelerated();
		this._previousDirection = this._getCumulativeDirection(dx, dy) ?? this._previousDirection;

		const delta = this._getDelta(dx, dy, this._previousDirection, false);
		const distance = this._getDelta(
			TouchpadConstants.TOUCHPAD_BASE_WIDTH,
			TouchpadConstants.TOUCHPAD_BASE_HEIGHT,
			this._previousDirection,
			true,
		);

		switch (event.get_gesture_phase()) {
			case Clutter.TouchpadGesturePhase.BEGIN:
			case Clutter.TouchpadGesturePhase.UPDATE:
				this.emit('update', time, delta, distance, this._previousDirection);
				break;
			case Clutter.TouchpadGesturePhase.END:
			case Clutter.TouchpadGesturePhase.CANCEL:
				this.emit('end', time, distance, this._previousDirection);
				this._state = TouchpadState.NONE;
				break;
		}

		return Clutter.EVENT_STOP;
	}

	protected _getDelta(dx: number, dy: number, direction: GestureDirection, _noOverride: boolean) {
		switch (direction) {
			case GestureDirection.LEFT:
			case GestureDirection.RIGHT:
				return dx;
			case GestureDirection.UP:
			case GestureDirection.DOWN:
				return dy;
		}
	}

	protected _getCumulativeDirection(dx: number, dy: number): GestureDirection | undefined {
		this._cumulativeX += dx * this.SWIPE_MULTIPLIER;
		this._cumulativeY += dy * this.SWIPE_MULTIPLIER;

		const cdx = this._cumulativeX;
		const cdy = this._cumulativeY;
		const distance = Math.sqrt(cdx * cdx + cdy * cdy);

		if (distance >= TouchpadConstants.DRAG_THRESHOLD_DISTANCE) {
			this._cumulativeX = 0;
			this._cumulativeY = 0;
			return this._getDirection(cdx, cdy);
		}
	}

	private _getDirection(cdx: number, cdy: number): GestureDirection {
		if (Math.abs(cdx) < Math.abs(cdy)) {
			return cdy >= 0 ? GestureDirection.DOWN : GestureDirection.UP;
		}
		return cdx >= 0 ? GestureDirection.RIGHT : GestureDirection.LEFT;
	}
});

// this is for compatibility with `TouchpadSwipeGesture` from gnome-shell
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
}, class TouchpadSwipeGesture extends TouchpadSwipeTracker {
	orientation: Clutter.Orientation;
	private _followNaturalScroll: boolean;
	private _switchedOrientation: Clutter.Orientation;

	constructor(
		nfingers: number[],
		allowedModes: Shell.ActionMode,
		orientation: Clutter.Orientation,
		followNaturalScroll = true,
		checkAllowedGesture = undefined,
		gestureSpeed = 1.0,
	) {
		super({
			nfingers: nfingers,
			allowedModes: allowedModes,
			checkAllowedGesture: checkAllowedGesture,
			gestureSpeed: gestureSpeed,
			triggerDirections: TouchpadSwipeGesture._getTriggerDirection(orientation),
		} as ITouchpadSwipeKlassConstructorProperties);

		this.orientation = orientation;
		this._switchedOrientation = orientation;
		this._followNaturalScroll = followNaturalScroll;
		this.SWIPE_MULTIPLIER = TouchpadConstants.SWIPE_MULTIPLIER * (typeof (gestureSpeed) !== 'number' ? 1.0 : gestureSpeed);
	}

	switchOrientationTo(orientation: Clutter.Orientation) {
		this._switchedOrientation = orientation;
	}

	private static _getTriggerDirection(orientation: Clutter.Orientation) {
		switch (orientation) {
			case Clutter.Orientation.HORIZONTAL:
				return [GestureDirection.LEFT, GestureDirection.RIGHT];
			case Clutter.Orientation.VERTICAL:
				return [GestureDirection.UP, GestureDirection.DOWN];
		}
	}

	override _getCumulativeDirection(dx: number, dy: number) {
		if (this._state !== TouchpadState.HANDLING) {
			// this is before 'begin' is emitted.
			this._switchedOrientation = this.orientation;
			return super._getCumulativeDirection(dx, dy);
		}

		switch (this._switchedOrientation) {
			case Clutter.Orientation.HORIZONTAL:
				return GestureDirection.RIGHT;
			case Clutter.Orientation.VERTICAL:
				return GestureDirection.DOWN;
		}
	}

	override _getDelta(dx: number, dy: number, direction: GestureDirection, noOverride: boolean) {
		let delta = super._getDelta(dx, dy, direction, noOverride);
		if (!noOverride && this._followNaturalScroll) {
			delta = -delta;
		}
		return delta;
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