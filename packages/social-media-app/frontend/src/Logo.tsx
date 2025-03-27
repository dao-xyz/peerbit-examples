import { useNavigate } from "react-router-dom";
import Logo from "/android-icon-192x192.png";

export const HeaderLogo = ({ onClick }: { onClick?: () => void }) => {
    const navigate = useNavigate();
    const asText = () => {
        return (
            <span
                className="p-1"
                style={{
                    fontSize: "1.5rem",
                    marginTop: "-0.4rem",
                    fontFamily: '"Gamja Flower", sans-serif',
                    fontWeight: 400,
                    fontStyle: "normal",
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
                height: "auto",
                marginLeft: "0px",
                marginTop: "-5px",
                width: "auto",
            }}
        />
    );
    return (
        <button
            className="btn p-0 mb-[-10px] rounded-none hover:cursor-pointer h-full flex flfex-col content-center items-center "
            onClick={() => {
                navigate("/", {});
                onClick && onClick();
            }}
        >
            {asImage()}
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
