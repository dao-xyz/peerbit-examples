// preview/DetailedPreview.tsx (or wherever this lives)
import React from "react";
import { Header } from "../../header/Header";
import { CanvasPreview } from "./Preview";
import { CanvasEditorProvider } from "../../edit/CanvasEditorProvider";
import { InlineEditor } from "../../edit/InlineEditor";
import { CloseableAppPane } from "../../edit/CloseableAppPane";
import { ToolbarEdit } from "../../edit/ToolbarEdit";
import { CanvasWrapper } from "../../CanvasWrapper";
import { HIGH_QUALITY } from "@giga-app/interface";
import {
    EditModeProvider,
    useEditModeContext,
} from "../../edit/EditModeProvider";
import { useCanvases } from "../../useCanvas";
import { toBase64URL } from "@peerbit/crypto";

const DetailedViewInner: React.FC = () => {
    const { viewRoot } = useCanvases();
    const { editMode, setEditMode } = useEditModeContext();

    const shouldShowMetaInfo = (viewRoot?.__indexed.path.length ?? 0) > 0;
    const canvasId = viewRoot ? toBase64URL(viewRoot.id) : "view-root";

    return (
        <div className="mx-auto w-full">
            {editMode ? (
                <CanvasEditorProvider canvas={viewRoot}>
                    <InlineEditor className="pb-12" />
                    <CloseableAppPane>
                        <ToolbarEdit
                            onSave={() => setEditMode(false)}
                            canvasId={canvasId}
                        />
                    </CloseableAppPane>
                </CanvasEditorProvider>
            ) : (
                // Expose data-canvas-id on the detailed container so tests can target it reliably
                <div data-canvas-id={canvasId}>
                    <CanvasPreview variant="detail" />
                </div>
            )}

            {shouldShowMetaInfo && (
                <div className="flex flex-row justify-center items-center w-full inset-shadow-sm">
                    <Header
                        variant="medium"
                        canvas={viewRoot}
                        detailed
                        className="h-8"
                        showPath={false}
                    />
                </div>
            )}
        </div>
    );
};

export const DetailedView: React.FC = () => {
    const { viewRoot } = useCanvases();
    return (
        <EditModeProvider>
            <CanvasWrapper canvas={viewRoot} quality={HIGH_QUALITY}>
                <DetailedViewInner />
            </CanvasWrapper>
        </EditModeProvider>
    );
};
