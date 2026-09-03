import { Link } from "react-router-dom";
import { ROUTES } from "../../constants/routes.constants";
import "./NotFoundPage.css";

export default function NotFoundPage() {
  return (
    <div className="not-found-page">
      <p className="not-found-page__code">404</p>
      <h1 className="not-found-page__title">Page not found</h1>
      <p className="not-found-page__description">
        The page you're looking for doesn't exist or may have moved.
      </p>
      <Link to={ROUTES.DASHBOARD} className="not-found-page__link">
        Back to dashboard
      </Link>
    </div>
  );
}

