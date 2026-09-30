// Conservative runtime endpoint catalogue, not a guarantee that every model is available.
// Refresh procedure and official source are documented in docs/providers.md.
export const BEDROCK_REGIONS = [
  ["us-west-1", "US West (N. California)"],
  ["ca-west-1", "Canada West (Calgary)"],
  ["ap-east-2", "Asia Pacific (Taipei)"],
  ["ap-southeast-3", "Asia Pacific (Jakarta)"],
  ["ap-southeast-4", "Asia Pacific (Melbourne)"],
  ["ap-southeast-5", "Asia Pacific (Malaysia)"],
  ["ap-southeast-6", "Asia Pacific (New Zealand)"],
  ["ap-southeast-7", "Asia Pacific (Thailand)"],
  ["il-central-1", "Israel (Tel Aviv)"],
  ["me-central-1", "Middle East (UAE)"],
  ["me-south-1", "Middle East (Bahrain)"],
  ["af-south-1", "Africa (Cape Town)"],
  ["us-east-2", "US East (Ohio)"],
  ["us-east-1", "US East (N. Virginia)"],
  ["us-west-2", "US West (Oregon)"],
  ["ap-south-2", "Asia Pacific (Hyderabad)"],
  ["ap-south-1", "Asia Pacific (Mumbai)"],
  ["ap-northeast-3", "Asia Pacific (Osaka)"],
  ["ap-northeast-2", "Asia Pacific (Seoul)"],
  ["ap-southeast-1", "Asia Pacific (Singapore)"],
  ["ap-southeast-2", "Asia Pacific (Sydney)"],
  ["ap-northeast-1", "Asia Pacific (Tokyo)"],
  ["ca-central-1", "Canada (Central)"],
  ["eu-central-1", "Europe (Frankfurt)"],
  ["eu-west-1", "Europe (Ireland)"],
  ["eu-west-2", "Europe (London)"],
  ["eu-south-1", "Europe (Milan)"],
  ["eu-west-3", "Europe (Paris)"],
  ["eu-south-2", "Europe (Spain)"],
  ["eu-north-1", "Europe (Stockholm)"],
  ["eu-central-2", "Europe (Zurich)"],
  ["sa-east-1", "South America (São Paulo)"],
].map(([id, label]) => Object.freeze({ id, label }));
export const BEDROCK_REGION_CATALOG = Object.freeze({
  verifiedOn: "2026-09-30",
  defaultRegion: "ap-southeast-2",
  source:
    "https://docs.aws.amazon.com/bedrock/latest/userguide/endpoints-region-availability.html",
  endpointReference:
    "https://docs.aws.amazon.com/general/latest/gr/bedrock.html",
  regions: BEDROCK_REGIONS,
});
export const isBedrockRegion = (region) =>
  BEDROCK_REGIONS.some(({ id }) => id === region);
