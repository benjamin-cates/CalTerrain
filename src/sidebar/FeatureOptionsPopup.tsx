import type { ReactNode, RefObject } from "react";
import type {
  TopographicFeatureCategory,
  TopographicFeatureOption,
  ViewSettings,
} from "../types";

export type CategorizedFeatureOption = {
  category: TopographicFeatureCategory;
  option: TopographicFeatureOption;
};

type FeatureOptionsPopupProps = {
  category: TopographicFeatureCategory;
  label: string;
  position: { top: number; left: number };
  popupRef: RefObject<HTMLDivElement | null>;
  featureListRef: RefObject<HTMLDivElement | null>;
  enableAllRef: RefObject<HTMLInputElement | null>;
  selectedFeatureCount: number;
  featureOptionCount: number;
  featureCategories: TopographicFeatureCategory[];
  loading: boolean;
  errors: { category: TopographicFeatureCategory; error: string }[];
  source: { label: string; href: string } | undefined;
  settings: ViewSettings;
  onClose: () => void;
  onSetAllFeatures: (category: TopographicFeatureCategory, enabled: boolean) => void;
  onSetEcoregionMap: (mode: "broad" | "fine") => void;
  searchQuery: string;
  onSearchQueryChange: (query: string) => void;
  quickAccessOptions: CategorizedFeatureOption[];
  filteredFeatureOptions: CategorizedFeatureOption[];
  renderFeatureOption: (item: CategorizedFeatureOption, list: "quick" | "all") => ReactNode;
  customPeakStorageError: string | null;
  customPeaksLoaded: boolean;
  onAddCustomPeak: () => void;
};

export function FeatureOptionsPopup(props: FeatureOptionsPopupProps) {
  return (
    <div
      ref={props.popupRef}
      className="topographic-popup"
      role="dialog"
      aria-label={`${props.label} options`}
      style={{
        top: props.position.top,
        left: props.position.left,
        maxHeight: `calc(100dvh - ${props.position.top}px - 16px)`,
      }}
    >
      <div className="topographic-popup-header topographic-feature-popup-header">
        <div>
          <strong>{props.label}</strong>
          <small>{props.selectedFeatureCount} of {props.featureOptionCount} enabled</small>
        </div>
        <div className="topographic-feature-popup-source">
          {props.source && (
            <a
              href={props.source.href}
              target="_blank"
              rel="noopener noreferrer"
              aria-label={`Data source: ${props.source.label}`}
              title={props.source.label}
            >
              {props.source.label}
            </a>
          )}
          <small>Shapes are simplified</small>
        </div>
        <button type="button" aria-label="Close feature options" onClick={props.onClose}>×</button>
      </div>
      <label className="topographic-enable-all">
        <input
          ref={props.enableAllRef}
          type="checkbox"
          checked={props.featureOptionCount > 0 &&
            props.selectedFeatureCount === props.featureOptionCount}
          disabled={props.loading || props.featureOptionCount === 0}
          onChange={(event) => {
            for (const category of props.featureCategories) {
              props.onSetAllFeatures(category, event.target.checked);
            }
          }}
        />
        <strong>All visible</strong>
      </label>
      {props.category === "ecoregions" && (
        <div className="ecoregion-map-options" role="group" aria-label="Ecoregion map visibility">
          <button type="button" aria-pressed={props.settings.regionMap === "broad"}
            onClick={() => props.onSetEcoregionMap("broad")}>
            Level 3 map
          </button>
          <button type="button" aria-pressed={props.settings.regionMap === "fine"}
            onClick={() => props.onSetEcoregionMap("fine")}>
            Level 4 map
          </button>
        </div>
      )}
      {props.loading && (
        <small className="topographic-status" role="status">
          {props.category === "ecoregions"
            ? "Loading ecoregion features or map…"
            : "Loading feature data…"}
        </small>
      )}
      {props.errors.map(({ category, error }) => (
        <small className="topographic-status is-error" role="alert" key={category}>
          {props.featureCategories.length > 1
            ? `${category === "highways" ? "Highways" : "Interstates"}: `
            : ""}
          {error}
        </small>
      ))}
      {!props.loading && props.errors.length === 0 && props.featureOptionCount === 0 && (
        <small className="topographic-status">No features are available.</small>
      )}
      {props.category === "peaks" && props.customPeakStorageError && (
        <small className="topographic-status is-error" role="alert">
          {props.customPeakStorageError}
        </small>
      )}
      <input className="topographic-feature-search" type="search"
        aria-label={`Search ${props.label.toLowerCase()}`}
        placeholder={`Search ${props.label.toLowerCase()}`}
        value={props.searchQuery}
        onChange={(event) => props.onSearchQueryChange(event.target.value)} />
      <div className="topographic-feature-header" aria-hidden="true">
        <span />
        <div><span>View</span><span>Cut</span><span>More</span></div>
      </div>
      <div className="topographic-feature-list" ref={props.featureListRef}>
        {props.quickAccessOptions.length > 0 && (
          <section className="topographic-feature-section" aria-label="Quick access features">
            <strong className="topographic-feature-section-title">Quick access</strong>
            {props.quickAccessOptions.map((item) => props.renderFeatureOption(item, "quick"))}
          </section>
        )}
        <section className="topographic-feature-section" aria-label="All features">
          <strong className="topographic-feature-section-title">All</strong>
          {props.filteredFeatureOptions.length > 0 ? props.filteredFeatureOptions.map((item) =>
            props.renderFeatureOption(item, "all")
          ) : props.featureOptionCount > 0 ? (
            <small className="topographic-status">No features match your search.</small>
          ) : null}
        </section>
      </div>
      {props.category === "peaks" && (
        <button
          className="add-custom-peak-button"
          type="button"
          disabled={!props.customPeaksLoaded}
          onClick={props.onAddCustomPeak}
        >Add custom mountain peak</button>
      )}
    </div>
  );
}
