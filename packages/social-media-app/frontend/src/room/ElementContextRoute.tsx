import { Outlet } from 'react-router-dom';
import { ElementProvider } from '../useElements';

const ElementContextRoute = () => {

    return (
        <ElementProvider>
            <Outlet />
        </ElementProvider>
    );
};

export default ElementContextRoute;