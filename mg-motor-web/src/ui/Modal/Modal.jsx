import { useEffect } from "react";
import CloseButton from "../CloseButton/CloseButton";
import "./Modal.css";

/**
 * Modal.jsx
 * -----------------------------------------------------------------------
 * Generic dialog shell. Business content (a form, a detail view) is
 * passed as children; this component only owns backdrop/escape/close
 * behavior, same pattern as Table and Badge.
 */
export default function Modal({ title, onClose, children, width = 480 }) {
  useEffect(() => {
    const handleKeyDown = (event) => {
      if (event.key === "Escape") onClose();
    };
    document.addEventListener("keydown", handleKeyDown);
    return () => document.removeEventListener("keydown", handleKeyDown);
  }, [onClose]);

  return (
    <div className="modal-backdrop" onClick={onClose}>
      <div className="modal" style={{ maxWidth: width }} onClick={(event) => event.stopPropagation()}>
        <div className="modal__header">
          <h2 className="modal__title">{title}</h2>
          <CloseButton onClick={onClose} />
        </div>
        <div className="modal__body">{children}</div>
      </div>
    </div>
  );
}
