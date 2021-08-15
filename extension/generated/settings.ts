/*
This is generated file
Do not edit directly
Edit schema file instead and then run "npm run initialize"
*/
import Gio from '@gi-types/gio';
import GLib from '@gi-types/glib';
import GObject from '@gi-types/gobject';
import { imports } from 'gnome-shell';
export declare type BooleanSettings =
	| 'default-session-workspace'
	| 'default-overview';
export declare type ChangedBooleanSettings =
	| 'changed::default-session-workspace'
	| 'changed::default-overview';
export declare type IntegerSettings = 'alttab-delay';
export declare type ChangedIntegerSettings = 'changed::alttab-delay';
export declare type DoubleSettings = 'touchpad-speed-scale';
export declare type ChangedDoubleSettings = 'changed::touchpad-speed-scale';
export declare type AllTypeSettings =
	| BooleanSettings
	| IntegerSettings
	| DoubleSettings;
export declare type AllTypeChangedSettings =
	| ChangedBooleanSettings
	| ChangedIntegerSettings
	| ChangedDoubleSettings;
export declare interface IExtensionSettings {
	get_boolean(key: BooleanSettings): boolean;
	set_boolean(key: BooleanSettings, value: boolean): boolean;
	get_int(key: IntegerSettings): number;
	set_int(key: IntegerSettings, value: number): boolean;
	get_double(key: DoubleSettings): number;
	set_double(key: DoubleSettings, value: number): boolean;
	reset(key: AllTypeSettings): void;
	connect(
		id: 'changed' | AllTypeChangedSettings,
		callback: (
			_settings: Gio.Settings,
			key: AllTypeSettings
		) => void
	): number;
	disconnect(id: number): void;
	bind(
		key: AllTypeSettings,
		object: GObject.Object,
		property: string,
		flags: Gio.SettingsBindFlags
	): void;
}
export function getSettings(): IExtensionSettings {
	return imports.misc.extensionUtils.getSettings();
}
