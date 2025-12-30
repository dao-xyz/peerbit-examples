import { Navigate, Route, Routes } from "react-router";
import { AuthScreen } from "./AuthScreen";
import { UpdatePasswordScreen } from "./UpdatePasswordScreen";

export const AuthRoutes = () => {
    return (
        <Routes>
            <Route path="/" element={<AuthScreen mode="sign-in" />} />
            <Route path="/sign-up" element={<AuthScreen mode="sign-up" />} />
            <Route path="/reset" element={<AuthScreen mode="reset" />} />
            <Route path="/update-password" element={<UpdatePasswordScreen />} />
            <Route path="*" element={<Navigate to="/auth" replace />} />
        </Routes>
    );
};
