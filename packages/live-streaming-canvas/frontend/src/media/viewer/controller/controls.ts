export interface ControlFunctions {
    setLive: () => void;
    play: () => void;
    pause: () => void;
    setProgress: (value: number) => void;
    mute?: () => void;
    unmute?: () => void;
    setVolume?: (value: number) => void;
    setSpeed?: (value: number) => void;
}
export interface ControlStates {
    isPlaying: boolean;
    progress: number;
}
export type ControlInterface = ControlFunctions & ControlStates;
