// Function to determine the device platform
function getDevicePlatform() {
    const ua = navigator.userAgent;
    // Check for mobile first
    if (/mobile/i.test(ua)) {
        if (/android/i.test(ua)) {
            return "Android";
        }
        if (/iPad|iPhone|iPod/.test(ua) && !window?.["MSStream"]) {
            return "iOS";
        }
        // Fallback for other mobile devices
        return "Mobile";
    }
    // For desktops, use navigator.platform for a bit more granularity
    const platform = navigator.platform.toLowerCase();
    if (platform.indexOf("win") !== -1) {
        return "Windows PC";
    }
    if (platform.indexOf("mac") !== -1) {
        return "Mac";
    }
    if (platform.indexOf("linux") !== -1) {
        return "Linux PC";
    }
    return "Desktop";
}

// Function to generate a random alphanumeric string of a given length
function generateRandomString(length = 5) {
    return Math.random()
        .toString(36)
        .substring(2, 2 + length);
}

// Function to generate the default device name
export function generateDefaultDeviceName() {
    const platformName = getDevicePlatform();
    const uniquePart = generateRandomString();
    return `${platformName} Device-${uniquePart}`;
}
