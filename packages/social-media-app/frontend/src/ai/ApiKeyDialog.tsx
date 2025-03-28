import React, { useState } from "react";
import * as Dialog from "@radix-ui/react-dialog";
import { useOpenAI } from "./OpenAiProvider"; // adjust the path as needed

interface ApiKeyDialogProps {
    open: boolean;
    onOpenChange: (open: boolean) => void;
}

const ApiKeyDialog: React.FC<ApiKeyDialogProps> = ({ open, onOpenChange }) => {
    const [apiKeyInput, setApiKeyInput] = useState("");
    const openAI = useOpenAI();

    return (
        <Dialog.Root open={open} onOpenChange={onOpenChange}>
            <Dialog.Portal>
                {/* Dark blurred background */}
                <Dialog.Overlay className="fixed inset-0 backdrop-blur-sm z-50" />
                {/* Centered modal */}
                <Dialog.Content className="fixed top-1/2 left-1/2 transform -translate-x-1/2 -translate-y-1/2 p-6 rounded-lg max-w-sm w-full z-50 bg-white dark:bg-neutral-800">
                    <Dialog.Title className="text-2xl font-bold mb-4">
                        Enter OpenAI API Key
                    </Dialog.Title>
                    <Dialog.Description className="mb-4">
                        Please enter your OpenAI API key to enable AI replies.
                    </Dialog.Description>
                    <input
                        type="text"
                        value={apiKeyInput}
                        onChange={(e) => setApiKeyInput(e.target.value)}
                        placeholder="API Key"
                        className="w-full p-2 mb-4 border rounded"
                    />
                    <div className="flex justify-end gap-2">
                        <button
                            onClick={() => onOpenChange(false)}
                            className="btn btn-secondary"
                        >
                            Cancel
                        </button>
                        <button
                            onClick={() => {
                                openAI.login(apiKeyInput);
                                onOpenChange(false);
                            }}
                            className="btn btn-primary"
                        >
                            Save
                        </button>
                    </div>
                </Dialog.Content>
            </Dialog.Portal>
        </Dialog.Root>
    );
};

export default ApiKeyDialog;
