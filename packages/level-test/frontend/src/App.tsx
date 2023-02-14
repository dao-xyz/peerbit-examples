import level from 'level'
import { useEffect, useRef } from 'react';

let logFn = globalThis.console.log.bind(globalThis.console)
const logChannel = new BroadcastChannel("/log");


globalThis.console.log = function (str) {
    //REM: Forward the string to the top window.
    //REM: https://developer.mozilla.org/en-US/docs/Web/API/Window/postMessage
    logChannel.postMessage(str);
    return logFn(str)
};

export const App = () => {
    const levelRef = useRef<level.Level>(null);
    useEffect(() => {
        if (levelRef.current) {
            return
        }
        levelRef.current = new level.Level('./path')
        levelRef.current.put('key', "hello").then(async () => {
            console.log(await levelRef.current.get('key'))
        })

    }, [])
    return <></>

};
