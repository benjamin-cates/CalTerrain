import { useCallback, useEffect, useMemo, useState } from "react";
import {
  countyId,
  countyName,
} from "../geo";
import {
  getHighwayRouteLines,
  getHighwayRouteNumbers,
} from "../features/highways";
import { longitudeLatitudeCellId } from "../longitudeLatitudeGrid";
import { getRailwayFeatureOptions } from "../features/railways";
import { getRiverFeatureOptions } from "../features/rivers";
import { lakeFeatureName } from "../features/lakes";
import type {
  Dataset,
  TopographicFeatureCategory,
  TopographicFeatureOption,
  TopographicFeatureSelections,
  ViewSettings,
} from "../types";
import { formatElevation } from "../units";
import { useBoundaryFeatureData } from "../terrain/useBoundaryFeatureData";
import { useCustomMountainPeaks } from "../features/useCustomMountainPeaks";
import { useEcoregionData } from "../features/useEcoregionData";
import { useEcoregionMapTexture } from "../features/useEcoregionMapTexture";
import { useHighwayData } from "../features/useHighwayData";
import { useMountainData } from "../features/useMountainData";
import { useRailwayData } from "../features/useRailwayData";
import { useRiverData } from "../features/useRiverData";

type UseFeatureDataOptions = {
  dataset: Dataset | null;
  settings: ViewSettings;
  countiesLoading: boolean;
  countiesError: string | null;
  dataError: string | null;
  loadCounties: () => void;
  topographicSelections: TopographicFeatureSelections;
};

export function useFeatureData({
  dataset,
  settings,
  countiesLoading,
  countiesError,
  dataError,
  loadCounties,
  topographicSelections,
}: UseFeatureDataOptions) {
  const nationalParkData = useBoundaryFeatureData(
    "/data/boundaries/national_parks.zip",
    "National park",
    "UNIT_CODE",
    "UNIT_NAME",
  );
  const lakeData = useBoundaryFeatureData(
    "/data/features/California_Lakes_mini.zip",
    "Lake",
    "GlobalID",
    "GlobalID",
  );
  const nationalForestData = useBoundaryFeatureData(
    "/data/boundaries/national_forests.zip",
    "National forest",
    "forestorgc",
    "forestname",
  );
  const ecoregionData = useEcoregionData();
  const {
    texture: ecoregionMapTexture,
    loading: ecoregionMapLoading,
    error: ecoregionMapError,
  } = useEcoregionMapTexture(settings.regionMap);
  useEffect(() => {
    if (settings.regionMap !== "none") void ecoregionData.load();
  }, [ecoregionData.load, settings.regionMap]);

  const [highwayDataRequested, setHighwayDataRequested] = useState(false);
  const [railwayDataRequested, setRailwayDataRequested] = useState(false);
  const [riverDataRequested, setRiverDataRequested] = useState(false);
  const [mountainDataRequested, setMountainDataRequested] = useState(false);
  const { features: highwayFeatures, loading: highwayLoading, error: highwayError } =
    useHighwayData(
      highwayDataRequested ||
      topographicSelections.highways.length > 0 ||
      topographicSelections.interstates.length > 0,
    );
  const { features: railwayFeatures, loading: railwayLoading, error: railwayError } =
    useRailwayData(railwayDataRequested || topographicSelections.railways.length > 0);
  const { features: riverFeatures, loading: riverLoading, error: riverError } =
    useRiverData(riverDataRequested || topographicSelections.rivers.length > 0);
  const { peaks, loading: mountainLoading, error: mountainError } =
    useMountainData(mountainDataRequested || topographicSelections.peaks.length > 0);
  const customMountainData = useCustomMountainPeaks();
  const allMountainPeaks = useMemo(
    () => [...peaks, ...customMountainData.peaks],
    [customMountainData.peaks, peaks],
  );
  const longitudeLatitudeGrid = dataset?.longitudeLatitudeGrid ?? null;
  const topographicOptions = useMemo<Record<TopographicFeatureCategory, TopographicFeatureOption[]>>(() => {
    const routeOptions = (routeType: "highways" | "interstates") => {
      const options = highwayFeatures
        ? getHighwayRouteNumbers(
          highwayFeatures,
          routeType === "highways" ? "highway" : "interstate",
        )
        : [];
      return options.map((number) => ({
        id: number,
        label: routeType === "highways" ? `CA ${number}` : `I-${number}`,
        lines: highwayFeatures
          ? getHighwayRouteLines(
            highwayFeatures,
            routeType === "highways" ? "highway" : "interstate",
            number,
          )
          : [],
      }));
    };
    const countyOptions = dataset?.counties?.features.map((feature) => ({
      id: countyId(feature),
      label: countyName(feature),
      geometry: feature.geometry,
    })) ?? [];
    countyOptions.sort((left, right) => left.label.localeCompare(right.label));
    const lakeNamesById = new Map(
      (lakeData.features?.features ?? []).map((feature) => [
        String(feature.properties.GlobalID ?? "").trim(),
        lakeFeatureName(feature),
      ]),
    );
    return {
      highways: routeOptions("highways"),
      interstates: routeOptions("interstates"),
      counties: countyOptions,
      peaks: allMountainPeaks.map((peak) => ({
        id: peak.id,
        label: peak.name,
        detail: [
          peak.range,
          peak.elevationMeters === undefined
            ? "Elevation unknown"
            : formatElevation(peak.elevationMeters, settings.measurementSystem),
        ].filter(Boolean).join(" · "),
        custom: peak.custom,
        position: peak.position,
        elevationMeters: peak.elevationMeters,
        prominenceMeters: peak.prominenceMeters,
        isolationKm: peak.isolationKm,
      })),
      nationalParks: nationalParkData.options,
      nationalForests: nationalForestData.options,
      longitudeLatitudeLines: (longitudeLatitudeGrid?.features ?? []).map((feature) => ({
        id: longitudeLatitudeCellId(feature),
        label: String(feature.properties.name ?? ""),
        geometry: feature.geometry,
      })),
      railways: railwayFeatures ? getRailwayFeatureOptions(railwayFeatures) : [],
      rivers: riverFeatures ? getRiverFeatureOptions(riverFeatures) : [],
      lakes: lakeData.options.map((option) => ({
        ...option,
        label: lakeNamesById.get(option.id) ?? option.label,
      })).sort((left, right) => left.label.localeCompare(right.label)),
      ecoregions: ecoregionData.options,
    };
  }, [
    allMountainPeaks,
    dataset,
    ecoregionData.options,
    highwayFeatures,
    lakeData.features,
    lakeData.options,
    longitudeLatitudeGrid,
    nationalForestData.options,
    nationalParkData.options,
    railwayFeatures,
    riverFeatures,
    settings.measurementSystem,
  ]);
  const topographicStatus = useMemo(() => ({
    highways: { loading: highwayLoading, error: highwayError },
    interstates: { loading: highwayLoading, error: highwayError },
    counties: { loading: countiesLoading, error: countiesError },
    peaks: { loading: mountainLoading, error: mountainError },
    nationalParks: { loading: nationalParkData.loading, error: nationalParkData.error },
    nationalForests: { loading: nationalForestData.loading, error: nationalForestData.error },
    longitudeLatitudeLines: { loading: !dataset, error: dataError },
    railways: { loading: railwayLoading, error: railwayError },
    rivers: { loading: riverLoading, error: riverError },
    lakes: { loading: lakeData.loading, error: lakeData.error },
    ecoregions: {
      loading: ecoregionData.loading || ecoregionMapLoading,
      error: ecoregionData.error ?? ecoregionMapError,
    },
  }), [
    countiesError,
    countiesLoading,
    dataError,
    dataset,
    ecoregionData.error,
    ecoregionData.loading,
    ecoregionMapError,
    ecoregionMapLoading,
    highwayError,
    highwayLoading,
    lakeData.error,
    lakeData.loading,
    mountainError,
    mountainLoading,
    nationalForestData.error,
    nationalForestData.loading,
    nationalParkData.error,
    nationalParkData.loading,
    railwayError,
    railwayLoading,
    riverError,
    riverLoading,
  ]);
  const requestTopographicData = useCallback((category: TopographicFeatureCategory) => {
    if (category === "highways" || category === "interstates") {
      setHighwayDataRequested(true);
    } else if (category === "counties") {
      void loadCounties();
    } else if (category === "peaks") {
      setMountainDataRequested(true);
    } else if (category === "nationalParks") {
      void nationalParkData.load();
    } else if (category === "lakes") {
      void lakeData.load();
    } else if (category === "nationalForests") {
      void nationalForestData.load();
    } else if (category === "railways") {
      setRailwayDataRequested(true);
    } else if (category === "rivers") {
      setRiverDataRequested(true);
    } else if (category === "ecoregions") {
      void ecoregionData.load();
    }
  }, [ecoregionData.load, lakeData.load, loadCounties, nationalForestData.load, nationalParkData.load]);

  return {
    allMountainPeaks,
    customMountainData,
    ecoregionData,
    ecoregionMapTexture,
    highwayFeatures,
    lakeFeatures: lakeData.features,
    nationalForestData,
    nationalParkData,
    railwayFeatures,
    riverFeatures,
    topographicOptions,
    topographicStatus,
    requestTopographicData,
  };
}
