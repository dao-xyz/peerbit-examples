import { IFrameContent, Element } from "@dao-xyz/social";
import { Fragment, useRef, useState } from "react";
import { Combobox, Transition } from "@headlessui/react";

import { MdCheck, MdClear, MdOpenWith } from "react-icons/md";
import { HiCheck, HiSelector } from "react-icons/hi";
import { BiWorld } from "react-icons/bi";
import { useApps } from "../useApps";
import { AiOutlineQuestionCircle } from "react-icons/ai";

export const AppSelect = () => {
    const { apps, resolve: resolveApp } = useApps();
    const [selected, setSelected] = useState(apps[0]);
    const [query, setQuery] = useState("");

    const [comboboxFocused, setComboboxFocused] = useState(false);
    const comboBoxRef = useRef<HTMLElement>();

    const filteredApps =
        query === ""
            ? apps
            : apps.filter((person) =>
                  [person.name, person.url].find((x) =>
                      x
                          .toLowerCase()
                          .replace(/\s+/g, "")
                          .includes(query.toLowerCase().replace(/\s+/g, ""))
                  )
              );

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
            onChange={(v) => setSelected(v)}
        >
            <div className="w-full relative mt-1">
                <div className="flex flex-row items-center relative w-full text-left bg-white rounded-lg shadow-md cursor-default focus:outline-none focus-visible:ring-2 focus-visible:ring-opacity-75 focus-visible:ring-white focus-visible:ring-offset-teal-300 focus-visible:ring-offset-2 sm:text-sm overflow-hidden">
                    <div className="absolute top-2 left-2">
                        {" "}
                        {selected.icon ? (
                            <img className="w-5 h-5" src={selected.icon}></img>
                        ) : (
                            <AiOutlineQuestionCircle className="w-5 h-5" />
                        )}
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
                        className="w-full border-none focus:ring-0 py-2 pl-10 pr-10 text-sm leading-5 text-gray-900"
                        displayValue={(person) =>
                            comboboxFocused ? person["url"] : person["name"]
                        }
                        onChange={(event) => {
                            setQuery(event.target.value);
                            resolveApp(event.target.value);
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
                    afterLeave={() => setQuery("")}
                >
                    <Combobox.Options className="absolute w-full py-1 mt-1 overflow-auto text-base bg-white rounded-md shadow-lg max-h-60 ring-1 ring-black ring-opacity-5 focus:outline-none sm:text-sm">
                        {filteredApps.map((app) => (
                            <Combobox.Option
                                key={app.url}
                                className={({ active, selected }) =>
                                    `cursor-default select-none relative py-2 pl-10 pr-4 ${optionStyle(
                                        active,
                                        selected
                                    )}`
                                }
                                value={app}
                            >
                                {({ selected, active }) => (
                                    <>
                                        <div className="table-cell items-center">
                                            <span
                                                className={`truncate ${
                                                    selected
                                                        ? "font-medium"
                                                        : "font-normal"
                                                }`}
                                            >
                                                {app.name}
                                            </span>
                                            <span className="ml-1 mr-1">-</span>
                                            <span
                                                className={`truncate font-mono text-xs`}
                                            >
                                                {app.url}
                                            </span>
                                        </div>
                                    </>
                                )}
                            </Combobox.Option>
                        ))}
                        {query.length > 0 && (
                            <Combobox.Option
                                className={({ active, selected }) =>
                                    `cursor-default select-none relative py-2 pl-10 pr-4 ${
                                        active
                                            ? "text-white bg-secondary-200"
                                            : "text-gray-900"
                                    }  ${selected && "bg-primary-200"}`
                                }
                                value={{ id: null, name: query }}
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
