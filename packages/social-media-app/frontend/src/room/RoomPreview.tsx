import { Room } from "@dao-xyz/social";

export const RoomPreview = (properties: { room: Room }) => {
    return <>Directory: {properties.room.name}</>;
};
