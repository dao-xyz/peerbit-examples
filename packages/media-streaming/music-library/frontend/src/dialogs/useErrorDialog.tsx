import React, {
    createContext,
    useCallback,
    useContext,
    useMemo,
    useState,
} from "react";
import * as Dialog from "@radix-ui/react-dialog";

type ErrorState = {
    title?: string;
    message: string;
    error?: Error | string;
    deadend?: boolean;
    severity?: "error" | "warning" | "info";
} | null;

type ErrorContextType = {
    showError: (properties: ErrorState) => void;
};

const ErrorContext = createContext<ErrorContextType | undefined>(undefined);

export const ErrorProvider: React.FC<{ children: React.ReactNode }> = ({
    children,
}) => {
    const [errorState, setErrorState] = useState<ErrorState>(null);
    const [showDetails, setShowDetails] = useState<boolean>(false);

    const showError = useCallback((properties: ErrorState) => {
        if (properties.error) {
            console.error("Error encountered:", properties.error);
        }
        setErrorState(properties);
        setShowDetails(false);
    }, []);

    const hideError = useCallback(() => {
        setErrorState(null);
        setShowDetails(false);
    }, []);
    const getSeverityClassnameForTitle = (severity: string) => {
        switch (severity) {
            case "error":
                return "text-[red] dark:text-[#ff4d4d]";
            case "warning":
                return "text-[yellow] dark:text-[#ffcc00]";
            case "info":
                return "";
            default:
                return "";
        }
    };
    const severityClassName = useMemo(() => {
        return getSeverityClassnameForTitle(errorState?.severity || "error");
    }, [errorState?.severity]);

    const avoidDefaultDomBehavior = (e: Event) => {
        e.preventDefault();
    };

    const onClickOutside = errorState?.deadend
        ? avoidDefaultDomBehavior
        : undefined;

    return (
        <ErrorContext.Provider value={{ showError }}>
            {children}
            <Dialog.Root
                open={!!errorState}
                onOpenChange={(open) => !open && hideError()}
            >
                <Dialog.Portal>
                    {/* Dark overlay */}
                    <Dialog.Overlay className="fixed inset-0  backdrop-blur-sm z-50" />
                    {/* Centered modal */}
                    <Dialog.Content
                        onPointerDownOutside={onClickOutside}
                        onInteractOutside={onClickOutside}
                        className="fixed top-1/2 left-1/2 transform -translate-x-1/2 -translate-y-1/2  p-6 rounded-lg max-w-sm w-full z-50 outline-0"
                    >
                        <Dialog.Title
                            className={`text-2xl font-bold ${severityClassName}`}
                        >
                            {errorState?.title || "Error"}
                        </Dialog.Title>
                        <Dialog.Description className="mt-4 ">
                            {errorState?.message}
                        </Dialog.Description>
                        {errorState?.error && (
                            <div className="mt-4">
                                <button
                                    onClick={() =>
                                        setShowDetails((prev) => !prev)
                                    }
                                    className="underline focus:outline-none"
                                >
                                    {showDetails
                                        ? "Hide Details"
                                        : "Show Details"}
                                </button>
                                {showDetails && (
                                    <pre className="mt-2 text-sm overflow-auto max-h-40 whitespace-pre-wrap">
                                        {typeof errorState.error === "string"
                                            ? errorState.error
                                            : errorState.error.stack ||
                                              errorState.error.message}
                                    </pre>
                                )}
                            </div>
                        )}
                        {!errorState?.deadend && (
                            <div className="mt-6 flex justify-end">
                                <button
                                    onClick={hideError}
                                    className="btn btn-secondary "
                                >
                                    Close
                                </button>
                            </div>
                        )}
                    </Dialog.Content>
                </Dialog.Portal>
            </Dialog.Root>
        </ErrorContext.Provider>
    );
};

export const useErrorDialog = (): ErrorContextType => {
    const context = useContext(ErrorContext);
    if (!context) {
        throw new Error("useError must be used within an ErrorProvider");
    }
    return context;
};
