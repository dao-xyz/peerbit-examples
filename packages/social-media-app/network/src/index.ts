// keep the array in one place (shared across frontend + CLIs)
export const BOOTSTRAP_ADDRS: string[] = [
    "/dns4/0d028beb98c16f8eca4e1c9fb069dffd7a5a59ec.peerchecker.com/tcp/4003/wss/p2p/12D3KooWJgGBvxZ3Yofw1FR5m9opCLA7RLM7UY5x7AHFytpTCtXY",
];

export type BootstrapMode = "prod" | "local" | "offline";
