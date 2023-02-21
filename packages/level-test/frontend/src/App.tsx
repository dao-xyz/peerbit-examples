import { useEffect, useRef } from "react";
import { Box } from "@mui/material";
/* 
let logFn = globalThis.console.log.bind(globalThis.console);
//const logChannel = new BroadcastChannel("/log");

globalThis.console.log = function (str) {
    //REM: Forward the string to the top window.
    //REM: https://developer.mozilla.org/en-US/docs/Web/API/Window/postMessage
    window.parent.postMessage(str, '*');
    return logFn(str);
};
console.log('helloXXX') */

export const App = () => {
    // const levelRef = useRef<level.Level>(null);
    const rrrr = useRef(null);
    useEffect(() => {
        /* if (levelRef.current) {
            return;
        }
        levelRef.current = new level.Level("./path");
        levelRef.current.put("key", "hello").then(async () => {
            console.log(await levelRef.current.get("key"));
        }); */
        /*  if (rrrr.current) {
             return;
         }
         rrrr.current = 'x';
         let key = 'zxc'
         localStorage.setItem(key, (localStorage.getItem(key) || '') + 'y')
         console.log(localStorage.getItem(key)) */
        // Wait for public key?
    }, []);
    return <Box sx={{ color: "red" }}>FROM IFRAME</Box>;
};
