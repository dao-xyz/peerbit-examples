import { IFrameContent, Element } from "@dao-xyz/social";
import { Fragment, useReducer, useRef, useState } from "react";
import { Combobox, Transition } from "@headlessui/react";

import { HiSelector } from "react-icons/hi";
import { useApps } from "../useApps";
import { AiOutlineQuestionCircle } from "react-icons/ai";
import { SimpleWebManifest } from "@dao-xyz/app-service";

const unknownApp = (url: string) => {
    return new SimpleWebManifest({ url });
};

export const AppSelect = (properties: {
    onSelected: (app: SimpleWebManifest) => any;
}) => {
    const { apps, search: appSearch, history: appHistory } = useApps();
    const [selected, setSelected] = useState<SimpleWebManifest>(
        apps[0] || unknownApp("")
    );
    const [query, setQuery] = useState("");
    const [comboboxFocused, setComboboxFocused] = useState(false);
    const comboBoxRef = useRef<HTMLElement>();
    const [loadingApp, setLoadingApp] = useState(false);
    const filteredAppsRef = useRef<SimpleWebManifest[]>([]);
    const [_, forceUpdate] = useReducer((x) => x + 1, 0);

    const filter = async (urlOrName: string, eventTarget: HTMLInputElement) => {
        const out = await appSearch(urlOrName);
        if (urlOrName === eventTarget.value) {
            if (out.length > 0) {
                if (out[0]) {
                    setSelected(out[0]);
                } else {
                    setSelected(unknownApp(eventTarget.value));
                }
            }
        }
        console.log("FILTERED OUTU", out);
        filteredAppsRef.current = out;
        forceUpdate();
    };

    const optionStyle = (active: boolean, selected: boolean) => {
        /*   if (true) {
              return `${active ? "text-white bg-secondary-200" : "text-opacity-50"}  ${selected && "bg-primary-200"}`
          } */
        if (active && selected) {
            return "bg-primary-400";
        }
        if (active) {
            return "bg-secondary-200";
        }
        if (selected) {
            return "bg-primary-200";
        }
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
                appHistory.insert(v);
            }}
        >
            <div className="w-full relative ">
                <div className="flex flex-row items-center relative w-full text-left  rounded-lg shadow-md cursor-default focus:outline-none focus-visible:ring-2 focus-visible:ring-opacity-75 focus-visible:ring-white focus-visible:ring-offset-teal-300 focus-visible:ring-offset-2 sm:text-sm overflow-hidden">
                    <div className="absolute top-2 left-2">
                        {" "}
                        <Transition
                            show={!loadingApp}
                            enter="transform transition duration-[800ms]"
                            enterFrom="opacity-0 rotate-[-120deg] scale-50"
                            enterTo="opacity-100 rotate-0 scale-100"
                            leave="transform duration-200 transition ease-in-out"
                            leaveFrom="opacity-100 rotate-0 scale-100 "
                            leaveTo="opacity-0 scale-95 "
                        >
                            {selected?.icon ? (
                                <img
                                    className="w-5 h-5"
                                    src={selected.icon}
                                ></img>
                            ) : (
                                <AiOutlineQuestionCircle className="w-5 h-5 icon" />
                            )}
                        </Transition>
                    </div>
                    <Combobox.Input
                        onClick={() => {
                            console.log("CLICKED!");
                            setComboboxFocused(true);
                        }}
                        onBlur={() => {
                            console.log("BLUR!");
                            setComboboxFocused(false);
                        }}
                        className="test-ccc w-full border-none focus:ring-0 py-2 pl-10 pr-10 text-sm leading-5 "
                        displayValue={(person) => {
                            return comboboxFocused
                                ? person["url"]
                                : person["title"] || person["url"];
                        }}
                        onChange={(event) => {
                            let eventTargetValue = event.target.value;
                            setQuery(eventTargetValue);
                            setLoadingApp(true);
                            setSelected(unknownApp(event.target.value));
                            filter(eventTargetValue, event.target).finally(
                                () => {
                                    if (
                                        eventTargetValue === event.target.value
                                    ) {
                                        setLoadingApp(false);
                                    }
                                }
                            );
                        }}
                    />
                    <Combobox.Button className="absolute inset-y-0 right-0 flex items-center pr-2">
                        <HiSelector
                            className="w-5 h-5 text-gray-400"
                            aria-hidden="true"
                        />
                    </Combobox.Button>
                </div>
                <Transition
                    as={Fragment}
                    leave="transition ease-in duration-100"
                    leaveFrom="opacity-100"
                    leaveTo="opacity-0"
                    /*   afterLeave={() => setQuery("")} */
                >
                    <Combobox.Options className="absolute w-full py-1 mt-1 overflow-auto text-base bg-neutral-50 dark:bg-neutral-900 rounded-md shadow-lg max-h-60 ring-1 ring-black ring-opacity-5 focus:outline-none sm:text-sm">
                        {filteredAppsRef.current.map((app, ix) => (
                            <Combobox.Option
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
                                        {/*  <span className="ml-1 mr-1">-</span> */}
                                        <span
                                            className={`truncate font-mono text-xs`}
                                        >
                                            {app.url}
                                        </span>
                                    </div>
                                )}
                            </Combobox.Option>
                        ))}
                        {query.length > 0 && (
                            <Combobox.Option
                                className={({ active, selected }) =>
                                    `cursor-default select-none relative py-2 pl-10 pr-4 ${
                                        active
                                            ? "bg-primary-400; dark: bg-primary-600"
                                            : "text-gray-900"
                                    }  ${
                                        selected &&
                                        "bg-primary-600; dark: bg-primary-200"
                                    }`
                                }
                                value={unknownApp(query)}
                            >
                                {query}
                            </Combobox.Option>
                        )}
                    </Combobox.Options>
                </Transition>
            </div>
        </Combobox>
    );
};
