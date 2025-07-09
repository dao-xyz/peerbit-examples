import { useNavigate } from "react-router";
import Logo from "/android-icon-192x192.png";

export const HeaderLogo = ({
    onClick,
    className,
}: {
    onClick?: () => void;
    className?: string;
}) => {
    const navigate = useNavigate();
    const asText = () => {
        return (
            <span
                className="p-0"
                style={{
                    fontSize: "1.5rem",
                    fontFamily: '"Gamja Flower", sans-serif',
                    fontWeight: 400,
                    fontStyle: "normal",
                    lineHeight: "0.8",
                }}
            >
                Giga
            </span>
        );
    };
    const asImage = () => (
        <img
            className="mr-auto ml-2 dark:invert"
            src={Logo}
            style={{
                maxWidth: "40px",
                height: "inherit",
                marginLeft: "0px",
                marginTop: "-5px",
                width: "auto",
                objectFit: "contain",
            }}
        />
    );
    return (
        <button
            className={
                "p-0  rounded-none hover:cursor-pointer h-full flex flex-col content-center items-center outline-0  border-none bg-transparent btn-bouncy " +
                className
            }
            onClick={() => {
                navigate("/", {});
                onClick && onClick();
            }}
        >
            {/* {asImage()} */}
            {asText()}
        </button>
    );
};

/*

.alfa-slab-one-regular {
  font-family: "Alfa Slab One", serif;
  font-weight: 400;
  font-style: normal;
}
*/
