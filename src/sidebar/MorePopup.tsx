import type { CSSProperties, ReactNode, RefObject } from "react";
import type { ViewSettings } from "../types";
import { formatArea, formatDistance, formatElevation, formatLength } from "../units";

type MoreActionCategoryName = "convert" | "analysis" | "view" | "edit";

function MoreActionCategory({
  category,
  children,
}: {
  category: MoreActionCategoryName;
  children: ReactNode;
}) {
  return (
    <div className="more-popup-action-category" role="group" aria-label={`${category} actions`}>
      <span className="more-popup-action-icon" aria-hidden="true">
        <svg viewBox="0 0 20 20" fill="none">
          {category === "convert" && (
            <path d="M3 6h12l-3-3m3 3-3 3M17 14H5l3 3m-3-3 3-3"
              stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round" />
          )}
          {category === "analysis" && (
            <path d="M3 3v14h14M6 13l3-4 3 2 4-6"
              stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round" />
          )}
          {category === "view" && (
            <>
              <path d="M1.8 10s3-5 8.2-5 8.2 5 8.2 5-3 5-8.2 5-8.2-5-8.2-5Z"
                stroke="currentColor" strokeWidth="1.4" />
              <circle cx="10" cy="10" r="2.2" stroke="currentColor" strokeWidth="1.4" />
            </>
          )}
          {category === "edit" && (
            <path d="m3 14.5-.7 3.2 3.2-.7L16.8 5.7a1.8 1.8 0 0 0-2.5-2.5L3 14.5Zm9.9-9.9 2.5 2.5"
              stroke="currentColor" strokeWidth="1.4" strokeLinecap="round" strokeLinejoin="round" />
          )}
        </svg>
      </span>
      <div className="more-popup-action-list">{children}</div>
    </div>
  );
}

export function MorePopup({
  name,
  type,
  detail,
  convertLabel,
  conversionDisabled,
  perimeterMeters,
  conversionHelp,
  areaSquareMeters,
  lengthMeters,
  medianElevationMeters,
  medianElevationLoading,
  medianElevationError,
  prominenceMeters,
  isolationKm,
  measurementSystem,
  popupRef,
  style,
  className,
  onClose,
  onConvert,
  onFocus,
  showDetails,
  viewActions,
  headerActions,
  analysisActions,
  editActions,
  children,
  onBack,
  onReturnToList,
}: {
  name: string;
  type: string;
  detail?: string;
  convertLabel?: string;
  conversionDisabled?: boolean;
  conversionHelp?: string;
  perimeterMeters?: number;
  areaSquareMeters?: number;
  lengthMeters?: number;
  medianElevationMeters?: number | null;
  medianElevationLoading?: boolean;
  medianElevationError?: string | null;
  prominenceMeters?: number;
  isolationKm?: number;
  measurementSystem: ViewSettings["measurementSystem"];
  popupRef: RefObject<HTMLDivElement | null>;
  style: CSSProperties;
  className?: string;
  onClose: () => void;
  onConvert?: () => void;
  onFocus: () => void;
  showDetails: boolean;
  viewActions?: ReactNode;
  headerActions?: ReactNode;
  analysisActions?: ReactNode;
  editActions?: ReactNode;
  children?: ReactNode;
  onBack?: () => void;
  onReturnToList?: () => void;
}) {
  return (
    <div ref={popupRef} className={`topographic-popup more-popup${className ? ` ${className}` : ""}`} role="dialog"
      aria-label={`${name} details`} style={style}>
      <div className={`topographic-popup-header${onReturnToList ? " feature-detail-popup-header" : ""}`}>
        {onReturnToList && (
          <button type="button" className="feature-detail-back" aria-label="Back to feature list"
            title="Back to feature list" onClick={onReturnToList}>
            <svg viewBox="0 0 20 20" fill="none" aria-hidden="true">
              <path d="m12 4-6 6 6 6" stroke="currentColor" strokeWidth="1.7"
                strokeLinecap="round" strokeLinejoin="round" />
            </svg>
          </button>
        )}
        <div>
          <strong>{name}</strong>
          <small>{type}</small>
        </div>
        <div className="more-popup-header-actions">
          {headerActions}
          {onBack && <button type="button" aria-label="Back to feature details" onClick={onBack}>‹</button>}
          <button type="button" aria-label={`Close ${name} details`} onClick={onClose}>×</button>
        </div>
      </div>
      {showDetails && (
        <>
          <div className="more-popup-actions">
            {convertLabel && onConvert && (
              <MoreActionCategory category="convert">
                <div className="more-popup-convert">
                  <button type="button" disabled={conversionDisabled} onClick={onConvert}>
                    {convertLabel}
                  </button>
                  {conversionDisabled && conversionHelp && <small>{conversionHelp}</small>}
                </div>
              </MoreActionCategory>
            )}
            {analysisActions && (
              <MoreActionCategory category="analysis">{analysisActions}</MoreActionCategory>
            )}
            <MoreActionCategory category="view">
              <button type="button" onClick={onFocus}>Move into focus</button>
              {viewActions}
            </MoreActionCategory>
            {editActions && <MoreActionCategory category="edit">{editActions}</MoreActionCategory>}
          </div>
          <dl className="more-popup-measurements">
            {detail && (
              <>
                <dt>Details</dt>
                <dd className="more-popup-measurement-detail">{detail}</dd>
              </>
            )}
            {perimeterMeters !== undefined && (
              <>
                <dt>Perimeter</dt>
                <dd>{formatLength(perimeterMeters, measurementSystem)}</dd>
              </>
            )}
            {areaSquareMeters !== undefined && (
              <>
                <dt>Enclosed area</dt>
                <dd>{formatArea(areaSquareMeters, measurementSystem)}</dd>
              </>
            )}
            {lengthMeters !== undefined && (
              <>
                <dt>Total length</dt>
                <dd>{formatLength(lengthMeters, measurementSystem)}</dd>
              </>
            )}
            {medianElevationMeters !== undefined && (
              <>
                <dt>Median perimeter elevation</dt>
                <dd
                  role={medianElevationError ? "alert" : medianElevationLoading ? "status" : undefined}
                >
                  {medianElevationError
                    ? `Could not sample elevation: ${medianElevationError}`
                    : medianElevationLoading
                      ? "Sampling terrain elevations…"
                      : medianElevationMeters === null
                        ? "Unavailable"
                        : formatElevation(medianElevationMeters, measurementSystem)}
                </dd>
              </>
            )}
            {prominenceMeters !== undefined && (
              <>
                <dt>Prominence</dt>
                <dd>{formatElevation(prominenceMeters, measurementSystem)}</dd>
              </>
            )}
            {isolationKm !== undefined && (
              <>
                <dt>Isolation</dt>
                <dd>{formatDistance(isolationKm, measurementSystem)}</dd>
              </>
            )}
          </dl>
        </>
      )}
      {children}
    </div>
  );
}
