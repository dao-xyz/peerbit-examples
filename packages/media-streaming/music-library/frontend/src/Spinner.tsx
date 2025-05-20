import { ClipLoader, ScaleLoader } from "react-spinners";

export const SpinnerSong = () => {
    return <ScaleLoader color="var(--color-emerald-500)" />;
};

export const SpinnerCircle = () => {
    return <ClipLoader size={20} color="var(--color-emerald-500)" />;
};
