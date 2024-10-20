export interface ControlFunctions {
    play: () => void;
    pause: () => void;
    setProgress: (value: number | "live") => void;
    mute?: () => void;
    unmute?: () => void;
    setVolume?: (value: number) => void;
    setSpeed?: (value: number) => void;
}
export interface ControlStates {
    isPlaying: boolean;
    progress?: number | "live";
    maxTime: number;
    currentTime: number;
}
export type ControlInterface = ControlFunctions & ControlStates;
