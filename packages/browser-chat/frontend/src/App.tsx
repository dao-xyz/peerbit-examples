import { useEffect, useState } from 'react';
import { Box, Grid, Typography } from '@mui/material';
export const App = () => {
  /* const [client, setClient] = useState<Awaited<ReturnType<typeof api>> | undefined>();
  const [password, setPassword] = useState<string>();
  const [id, setId] = useState<string>(); */
  useEffect(() => {
    console.log()
  }, [])
  return (
    <Box sx={{ backgroundColor: '#21242d', color: 'white', fontFamily: 'monospace' }}>
      <Grid container sx={{ p: 4, height: '100vh' }}>
        <Grid item container direction='column' maxWidth='400px' >
          <Grid item container direction='row' alignItems='center' mb={2}>
            <Grid mr={2} item><img width="45px" height="auto" src="./logo192.png"></img></Grid>
            <Grid item><Typography variant="h5">PeerbitChat</Typography></Grid>
          </Grid>
          <Grid item><Typography variant="overline">Id</Typography></Grid>
          {/*  <Grid item>{id}</Grid>
          <Grid item sx={{ pt: 2 }}><Typography variant="overline">Address</Typography></Grid>
          <Grid item>/dns4/{window.location.hostname}/tcp/4002/wss/p2p/{id}</Grid> */}
        </Grid>
      </Grid>
    </Box >
  );
}