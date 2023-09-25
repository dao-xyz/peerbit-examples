import { SearchRequest } from "@peerbit/document";
import { Button, Grid, TextField, Typography } from "@mui/material";
import { useEffect, useRef, useState } from "react";
import { useNavigate, useParams } from "react-router-dom";
import { inIframe, usePeer } from "@peerbit/react";
import { Rooms } from "./room/Rooms";
import { Header } from "./Header";

export const Home = () => {
    const { peer } = usePeer();


    return (
        <>
            {!inIframe() && <Header></Header>}

            <Rooms />
        </>
    );
};
