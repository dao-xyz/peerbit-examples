import { SearchRequest } from "@peerbit/document";
import { Button, Grid, TextField, Typography } from "@mui/material";
import { useEffect, useRef, useState } from "react";
import { useNavigate } from "react-router-dom";
import { usePeer } from "@peerbit/react";
import { CanvasAndReplies } from "./canvas/CanvasAndReplies";

export const Home = () => {
    const { peer } = usePeer();
    return (
        <>
            <CanvasAndReplies />
        </>
    );
};
