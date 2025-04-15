import { useEffect } from "react";
import { useView } from "./ViewContex";

export const BodyStyler: React.FC = () => {
    const { view } = useView();

    useEffect(() => {
        // Remove any previous background classes (make sure these classes
        // are present somewhere in your code so Tailwind keeps them in the build)
        document.body.classList.remove(
            "dark:bg-neutral-800",
            "dark:bg-neutral-950"
        );

        // Add the appropriate class based on the view.
        if (view === "chat") {
            document.body.classList.add("dark:bg-neutral-800");
        } else {
            document.body.classList.add("dark:bg-neutral-950");
        }

        // Optionally, you could return a cleanup function if needed.
        return () => {
            // Clean up if you want to remove the class when this component unmounts.
            document.body.classList.remove(
                "dark:bg-neutral-800",
                "dark:bg-neutral-950"
            );
        };
    }, [view]);

    return null; // This component doesn't need to render anything.
};
