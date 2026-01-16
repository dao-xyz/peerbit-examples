import { useEffect } from "react";
import { useVisualizationContext } from "./CustomizationProvider";
import { ChildVisualization } from "@giga-app/interface";
import { useIsActiveLayer } from "../../layers/ActiveLayerContext";

export const BodyStyler: React.FC = () => {
    const { visualization, draft } = useVisualizationContext();
    const isActiveLayer = useIsActiveLayer();

    useEffect(() => {
        if (!isActiveLayer) return;
        // Remove any previous background classes (make sure these classes
        // are present somewhere in your code so Tailwind keeps them in the build)
        document.body.classList.remove(
            "dark:bg-neutral-800",
            "dark:bg-neutral-900"
        );

        document.body.classList.remove("bg-neutral-50", "bg-neutral-200");

        // Add the appropriate class based on the view.

        if (visualization?.view === ChildVisualization.CHAT) {
            document.body.classList.add("dark:bg-neutral-800");
            document.body.classList.add("bg-neutral-50");
        } else {
            document.body.classList.add("dark:bg-neutral-900");
            document.body.classList.add("bg-neutral-200");
        }

        // Optionally, you could return a cleanup function if needed.
        return () => {
            // Clean up if you want to remove the class when this component unmounts.
            document.body.classList.remove(
                "dark:bg-neutral-800",
                "dark:bg-neutral-950"
            );
        };
    }, [draft, visualization, visualization?.view, isActiveLayer]);

    return null; // This component doesn't need to render anything.
};
