export interface ControlFunctions {
    play: () => void;
    pause: () => void;
    mute?: () => void;
    unmute?: () => void;
    setVolume?: (value: number) => void;
}
export interface ControlStates {
    isPlaying: boolean;
}
export type ControlInterface = ControlFunctions & ControlStates;
