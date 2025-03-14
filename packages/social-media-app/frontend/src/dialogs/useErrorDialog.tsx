import React, { createContext, useCallback, useContext, useState } from "react";
import * as Dialog from "@radix-ui/react-dialog";

type ErrorState = {
    message: string;
    error?: Error;
} | null;

type ErrorContextType = {
    showError: (message: string, error?: Error) => void;
};

const ErrorContext = createContext<ErrorContextType | undefined>(undefined);

export const ErrorProvider: React.FC<{ children: React.ReactNode }> = ({
    children,
}) => {
    const [errorState, setErrorState] = useState<ErrorState>(null);
    const [showDetails, setShowDetails] = useState<boolean>(false);

    const showError = useCallback((message: string, error?: Error) => {
        if (error) {
            console.error("Error encountered:", error);
        }
        setErrorState({ message, error });
        setShowDetails(false);
    }, []);

    const hideError = useCallback(() => {
        setErrorState(null);
        setShowDetails(false);
    }, []);

    return (
        <ErrorContext.Provider value={{ showError }}>
            {children}
            <Dialog.Root
                open={!!errorState}
                onOpenChange={(open) => !open && hideError()}
            >
                <Dialog.Portal>
                    {/* Dark overlay */}
                    <Dialog.Overlay className="fixed inset-0 bg-black bg-opacity-50 z-50" />
                    {/* Centered modal */}
                    <Dialog.Content className="fixed top-1/2 left-1/2 transform -translate-x-1/2 -translate-y-1/2 bg-white dark:bg-black p-6 rounded-lg shadow-xl max-w-sm w-full z-50">
                        <Dialog.Title className="text-2xl font-bold text-[red]">
                            Error
                        </Dialog.Title>
                        <Dialog.Description className="mt-4 text-gray-700">
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
                                        {errorState.error.stack ||
                                            errorState.error.message}
                                    </pre>
                                )}
                            </div>
                        )}
                        <div className="mt-6 flex justify-end">
                            <button
                                onClick={hideError}
                                className="px-4 py-2 bg-red-600  rounded hover:bg-red-700 focus:outline-none"
                            >
                                Close
                            </button>
                        </div>
                    </Dialog.Content>
                </Dialog.Portal>
            </Dialog.Root>
        </ErrorContext.Provider>
    );
};

export const useError = (): ErrorContextType => {
    const context = useContext(ErrorContext);
    if (!context) {
        throw new Error("useError must be used within an ErrorProvider");
    }
    return context;
};
