import { Fragment, useReducer, useRef, useState } from "react";
import {
    Combobox,
    ComboboxButton,
    ComboboxInput,
    ComboboxOption,
    ComboboxOptions,
    Transition,
} from "@headlessui/react";
import { useApps } from "../../content/useApps";
import { FaPlus } from "react-icons/fa6";
import { AiOutlineQuestionCircle } from "react-icons/ai";
import { SimpleWebManifest } from "@dao-xyz/social";
import { InvalidAppError } from "@dao-xyz/social";

const unknownApp = (url: string) => new SimpleWebManifest({ url });
const isNative = (app: SimpleWebManifest) => app.url.startsWith("native:");

export const AppSelect = (properties: {
    onSelected: (app: SimpleWebManifest) => any;
}) => {
    const {
        apps,
        search: appSearch,
        history: appHistory,
        getCuratedNativeApp: getNativeApp,
    } = useApps();
    const nativeApps = apps
        .filter((x) => x.isNative)
        .map((x) => getNativeApp(x.url));

    const [selected, setSelected] = useState<SimpleWebManifest>(
        apps[0] || unknownApp("")
    );
    const [query, setQuery] = useState("");
    const [loadingApp, setLoadingApp] = useState(false);
    const filteredAppsRef = useRef<SimpleWebManifest[]>([]);
    const [_, forceUpdate] = useReducer((x) => x + 1, 0);

    const filter = async (urlOrName: string, target: HTMLInputElement) => {
        const out = await appSearch(urlOrName);
        if (urlOrName === target.value) {
            if (out.length > 0) {
                setSelected(out[0] || unknownApp(target.value));
            }
        }
        filteredAppsRef.current = out;
        forceUpdate();
    };

    const optionStyle = (active: boolean, selected: boolean) => {
        if (active && selected) return "bg-primary-400";
        if (active) return "bg-secondary-200";
        if (selected) return "bg-primary-200";
        return "text-opacity-50";
    };

    return (
        <Combobox
            value={selected}
            onChange={(v) => {
                setSelected(v);
                properties.onSelected(v);
                console.log("INSERT!", v);
                appHistory.insert(v).catch((e) => {
                    if (!(e instanceof InvalidAppError)) {
                        throw e;
                    }
                });
            }}
        >
            {({ open }) => (
                <div className="relative inline-block">
                    <ComboboxButton className="flex items-center justify-center btn btn-icon btn-icon-sm">
                        <>
                            {selected?.icon ? (
                                /*  <img
                                     src={selected.icon}
                                     alt="App Icon"
                                     className="w-[21px] h-[21px] p-[2px]"
                                 /> */
                                <FaPlus />
                            ) : (
                                <AiOutlineQuestionCircle />
                            )}
                        </>
                    </ComboboxButton>

                    <Transition
                        show={open}
                        as={Fragment}
                        enter="transition duration-200 ease-out"
                        enterFrom="opacity-0 scale-95"
                        enterTo="opacity-100 scale-100"
                        leave="transition duration-150 ease-in"
                        leaveFrom="opacity-100 scale-100"
                        leaveTo="opacity-0 scale-95"
                    >
                        {/* Positioning changed: bottom-full positions the popup above the button */}
                        <div className="absolute z-50 bottom-full left-0 mb-1 bg-neutral-50 dark:bg-neutral-900 rounded-md shadow-lg  ring-1 ring-black ring-opacity-5 focus:outline-none ">
                            <ComboboxOptions className="mt-1 w-[200px]  max-h-60 ">
                                {filteredAppsRef.current.map((app, ix) => (
                                    <ComboboxOption
                                        key={ix}
                                        className={({ active, selected }) =>
                                            `cursor-default select-none relative py-2 pl-10 pr-4 ${optionStyle(
                                                active,
                                                selected
                                            )}`
                                        }
                                        value={app}
                                    >
                                        {({ selected, active }) => (
                                            <div className="flex flex-col">
                                                <span
                                                    className={`truncate ${
                                                        selected
                                                            ? "font-medium"
                                                            : "font-normal"
                                                    }`}
                                                >
                                                    {app.title}
                                                </span>
                                                <span className="truncate font-mono text-xs">
                                                    {isNative(app)
                                                        ? app.title
                                                        : app.url}
                                                </span>
                                            </div>
                                        )}
                                    </ComboboxOption>
                                ))}
                                {query.length > 0 && (
                                    <ComboboxOption
                                        className={({ active, selected }) =>
                                            `cursor-default select-none relative py-2 pl-10 pr-4 ${
                                                active
                                                    ? "bg-primary-400 dark:bg-primary-600"
                                                    : "text-gray-900"
                                            } ${
                                                selected &&
                                                "bg-primary-600 dark:bg-primary-200"
                                            }`
                                        }
                                        value={unknownApp(query)}
                                    >
                                        {query}
                                    </ComboboxOption>
                                )}
                                {nativeApps.length > 0 && (
                                    <div className="m-1 flex gap-2 pt-1">
                                        {nativeApps.map((curatedApp) => {
                                            const app = curatedApp.manifest;

                                            /* TODO re-add trigger
                                             if (curatedApp.trigger) {
                                                return (
                                                    <curatedApp.trigger
                                                        key={app.url}
                                                        className="btn p-2 bg-white text-black rounded hover:bg-primary-200"
                                                    >
                                                        <BsCamera size={20} />
                                                    </curatedApp.trigger>
                                                );
                                            } */

                                            return (
                                                <button
                                                    key={app.url}
                                                    type="button"
                                                    onClick={() => {
                                                        setSelected(app);
                                                        properties.onSelected(
                                                            app
                                                        );
                                                        appHistory
                                                            .insert(app)
                                                            .catch((e) => {
                                                                if (
                                                                    !(
                                                                        e instanceof
                                                                        InvalidAppError
                                                                    )
                                                                )
                                                                    throw e;
                                                            });
                                                    }}
                                                    className="p-2 bg-white rounded hover:bg-primary-200"
                                                >
                                                    <div className="flex flex-row items-center gap-1">
                                                        <img
                                                            className="w-5 h-5"
                                                            src={app.icon}
                                                            alt="Native App Icon"
                                                        />
                                                    </div>
                                                </button>
                                            );
                                        })}
                                    </div>
                                )}
                            </ComboboxOptions>
                            <ComboboxInput
                                placeholder="Search for apps"
                                autoComplete="off"
                                className="border border-gray-300 rounded p-2 pr-10 text-sm leading-5 w-[200px]"
                                displayValue={(app?: SimpleWebManifest) => {
                                    if (app) {
                                        return !app.url || isNative(app)
                                            ? app.title
                                            : app.url;
                                    }
                                    return "";
                                }}
                                onFocus={(event) => {
                                    if (!query) {
                                        setLoadingApp(true);
                                        filter("", event.target).finally(() => {
                                            setLoadingApp(false);
                                        });
                                    }
                                }}
                                onChange={(event) => {
                                    const value = event.target.value;
                                    setQuery(value);
                                    if (value) {
                                        setLoadingApp(true);
                                        setSelected(unknownApp(value));
                                        filter(value, event.target).finally(
                                            () => {
                                                setLoadingApp(false);
                                            }
                                        );
                                    }
                                }}
                            />
                        </div>
                    </Transition>
                </div>
            )}
        </Combobox>
    );
};
