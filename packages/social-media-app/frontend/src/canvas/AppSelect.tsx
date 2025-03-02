import { Fragment, useReducer, useRef, useState } from "react";
import {
    Combobox,
    ComboboxButton,
    ComboboxInput,
    ComboboxOption,
    ComboboxOptions,
    Transition,
} from "@headlessui/react";
import { IoIosApps } from "react-icons/io";
import { useApps } from "../useApps";
import { AiOutlineQuestionCircle } from "react-icons/ai";
import { SimpleWebManifest } from "@dao-xyz/app-service";
import { InvalidAppError } from "@dao-xyz/social";
import { PiCaretUpDownBold } from "react-icons/pi";

const unknownApp = (url: string) => new SimpleWebManifest({ url });
const isNative = (app: SimpleWebManifest) => app.url.startsWith("native:");

export const AppSelect = (properties: {
    onSelected: (app: SimpleWebManifest) => any;
}) => {
    const { apps, search: appSearch, history: appHistory } = useApps();
    const [selected, setSelected] = useState<SimpleWebManifest>(
        apps[0] || unknownApp("")
    );
    const [query, setQuery] = useState("");
    const comboBoxRef = useRef<HTMLElement>();
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
        console.log("FILTERED OUT", out);
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
            ref={comboBoxRef}
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
                <div className="w-full relative">
                    {/* Icon container */}
                    <Transition
                        as="div"
                        show={!loadingApp}
                        enter="transform transition duration-[800ms]"
                        enterFrom="opacity-0 rotate-0 scale-50"
                        enterTo="opacity-100 rotate-0 scale-100"
                        leave="transform duration-200 transition ease-in-out"
                        leaveFrom="opacity-100 rotate-0 scale-100"
                        leaveTo="opacity-0 scale-95"
                        className="absolute top-[5px] left-[10px] 0"
                    >
                        <ComboboxButton className="flex flex-row items-center justify-start">
                            {/* <PiCaretUpDownBold size="20px" className="mr-1" /> */}
                            <div className="bg-white rounded dark:shadow-primary-20">
                                {selected?.icon ? (
                                    <img
                                        src={selected.icon}
                                        alt="App Icon"
                                        className="w-[21px] h-[21px] p-[2px]"
                                    />
                                ) : (
                                    <AiOutlineQuestionCircle className="w-[25px] h-[25px]" />
                                )}
                            </div>
                        </ComboboxButton>
                    </Transition>
                    <ComboboxInput
                        autoComplete="off"
                        disabled={!open}
                        // When open, expand to full width; otherwise, limit to 200px with ellipsis.
                        className={`border-none focus:outline-none py-2 pl-[40px] ${
                            open ? "pr-10" : ""
                        } text-sm leading-5 transition-all duration-200 ${
                            open ? "w-full" : "w-[0px] truncate"
                        }`}
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
                                filter(value, event.target).finally(() => {
                                    setLoadingApp(false);
                                });
                            }
                        }}
                    />

                    <Transition
                        show={open}
                        as={Fragment}
                        leave="transition ease-in duration-100"
                        leaveFrom="opacity-100"
                        leaveTo="opacity-0"
                    >
                        <ComboboxOptions
                            static
                            anchor="top"
                            className="w-[var(--input-width)] absolute py-1 mt-1 overflow-auto text-base bg-neutral-50 dark:bg-neutral-900 rounded-md shadow-lg max-h-60 ring-1 ring-black ring-opacity-5 focus:outline-none sm:text-sm"
                        >
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
                            {/* Horizontal list of native app icon buttons */}
                            <div className="border-t mt-1 pt-1 pl-2 flex gap-2">
                                {apps
                                    .filter((x) => x.isNative)
                                    .map((app) => (
                                        <button
                                            key={app.url}
                                            type="button"
                                            onClick={() => {
                                                setSelected(app);
                                                properties.onSelected(app);
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
                                            className="p-2 rounded hover:bg-primary-200"
                                        >
                                            <div className="flex flex-row items-center gap-1">
                                                <img
                                                    className="w-5 h-5"
                                                    src={app.icon}
                                                    alt="Native App Icon"
                                                />
                                            </div>
                                        </button>
                                    ))}
                            </div>
                        </ComboboxOptions>
                    </Transition>
                </div>
            )}
        </Combobox>
    );
};
