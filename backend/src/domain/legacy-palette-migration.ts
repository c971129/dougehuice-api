export interface LegacyPaletteColorMigration {
  oldCode: string;
  oldHex: string;
  newCode: string;
  newHex: string;
  deltaE2000: number;
  reliable: boolean;
}

export const LEGACY_DEMO_PALETTE_ID = "mard-basic-v1";
export const LEGACY_DEMO_TARGET_PALETTE_ID = "mard-291-v1";
export const LEGACY_DEMO_MIGRATION_VERSION = "legacy-demo-to-mard-291-v1@1";

const row = (
  oldCode: string,
  oldHex: string,
  newCode: string,
  newHex: string,
  deltaE2000: number,
): LegacyPaletteColorMigration => ({
  oldCode,
  oldHex,
  newCode,
  newHex,
  deltaE2000,
  reliable: deltaE2000 <= 6,
});

/**
 * Auditable one-way migration from the retired demo palette to MARD 291 v1.
 * Candidates are based on stored HEX + CIEDE2000, never on names or similar
 * looking codes. Rows above Delta-E 6 require human confirmation.
 */
export const LEGACY_DEMO_TO_MARD_291: readonly LegacyPaletteColorMigration[] = [
  row("M01", "#FFFDF8", "H2", "#FFFFFF", 2.52),
  row("M02", "#FFE79A", "A21", "#FFE395", 1.35),
  row("M03", "#FFB6B9", "F21", "#F4B1B4", 1.98),
  row("M04", "#F66B61", "A19", "#FD7B72", 3.86),
  row("M05", "#A868A0", "M11", "#9F7494", 6.42),
  row("M06", "#C9B8F4", "D9", "#D5B9F8", 2.73),
  row("M07", "#81C9F4", "C24", "#7DC4FF", 3.90),
  row("M08", "#37A7B7", "C22", "#67B4BE", 5.57),
  row("M09", "#91D7B5", "B28", "#9EE5B9", 4.09),
  row("M10", "#4E9C58", "B8", "#029D26", 7.78),
  row("M11", "#A66A42", "R21", "#AD6F3C", 3.50),
  row("M12", "#5B3A35", "G17", "#56403C", 4.41),
  row("M13", "#A9A6A2", "H3", "#B3B3B3", 4.31),
  row("M14", "#565B63", "H5", "#474747", 8.26),
  row("M15", "#20232A", "H6", "#2C2C2C", 5.45),
  row("M16", "#E8F1F5", "P12", "#E6EEF1", 0.81),
  row("A01", "#27313B", "C18", "#1C3344", 4.25),
  row("R12", "#E94359", "F25", "#E54B4F", 3.93),
  row("R08", "#FF7868", "A19", "#FD7B72", 2.36),
  row("P06", "#FFB0B5", "F14", "#FFA9AD", 1.87),
  row("Y04", "#FFD764", "A20", "#EFCD67", 3.21),
  row("B17", "#3FA7D6", "C5", "#01ACEB", 3.29),
  row("G11", "#62C6A3", "P6", "#60CFA8", 2.38),
  row("V09", "#8567D3", "D18", "#A45EC7", 7.74),
  row("W02", "#FFF4DF", "H19", "#F6EFE2", 3.25),
];

