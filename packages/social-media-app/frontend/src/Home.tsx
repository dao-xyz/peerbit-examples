import { SearchRequest } from "@peerbit/document";
import { Button, Grid, TextField, Typography } from "@mui/material";
import { useEffect, useRef, useState } from "react";
import { useNavigate } from "react-router-dom";
import { usePeer } from "@peerbit/react";
import { Rooms } from "./room/Rooms";

export const Home = () => {
    const { peer } = usePeer();
    return (
        <>
            <Rooms />
        </>
    );
};
