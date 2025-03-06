import React, { useEffect, useState } from "react";
import { useLocation, useNavigate } from "react-router-dom";
import TagInput from "./TagInput"; // import the controlled TagInput above
import { useCanvases } from "../canvas/useCanvas";
import { getCanvasPath } from "../routes";
import { IoIosArrowBack } from "react-icons/io";
import { Canvas } from "../canvas/Canvas";
import { Canvas as CanvasDB } from "@dao-xyz/social";

export const CanvasPath = () => {
    const navigate = useNavigate();
    const location = useLocation();
    const [focus, setFocus] = useState(false);
    const { path, root } = useCanvases();

    // Maintain controlled tags state (each tag is an address string)
    const [tags, setTags] = useState(() => path.slice(1).map((x) => x.address));

    // Update tags when the path changes externally.
    useEffect(() => {
        setTags(path.slice(1).map((x) => x.address));
    }, [path]);

    // When tags change, resolve the new path and navigate if needed.
    const handleTagsChange = async (newTags) => {
        console.log("NEW PATH", newTags);

        // newTags is an array of addresses
        const newPath = await root.getCreateRoomByPath(newTags);
        // Compare newPath with the current path.
        let eq = newPath.length === path.length;
        if (eq) {
            for (let i = 0; i < newPath.length; i++) {
                if (newPath[i] !== path[i]) {
                    eq = false;
                    break;
                }
            }
        }
        if (!eq) {
            console.log(
                "nEW CANVAS PATH",
                getCanvasPath(newPath[newPath.length - 1])
            );
            navigate(getCanvasPath(newPath[newPath.length - 1]), {});
            setTags(newPath.slice(1).map((x) => x.address));
        }
    };

    const renderCanvas = (canvas: CanvasDB, ix) => (
        <Canvas key={ix} scaled width={60} height={35} canvas={canvas} />
    );

    return (
        <div className="flex flex-row gap-2">
            {path.length > 1 && (
                <button
                    className="mr-auto btn btn-icon flex flex-row items-center gap-1"
                    onClick={() => {
                        navigate(getCanvasPath(path[path.length - 2]), {});
                    }}
                >
                    <IoIosArrowBack size={15} />
                </button>
            )}
            {focus ? (
                <div className="w-full">
                    <TagInput
                        tags={tags}
                        onTagsChange={handleTagsChange}
                        renderTag={({ tag }, ix) => renderCanvas(tag, ix)}
                    />
                </div>
            ) : (
                <button
                    className="btn w-full leading-normal px-2 flex flex-row cursor-pointer"
                    onClick={() => setFocus(true)}
                >
                    {path.length > 1 ? (
                        path.slice(1).map((x, ix) => {
                            return (
                                <div
                                    key={ix}
                                    className="flex flex-row items-center"
                                >
                                    {ix > 0 && <span className="mx-1">/</span>}
                                    {renderCanvas(x, ix)}
                                </div>
                            );
                        })
                    ) : (
                        <span>/</span>
                    )}
                </button>
            )}
        </div>
    );
};
