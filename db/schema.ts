import { real, sqliteTable, text } from "drizzle-orm/sqlite-core";

export const savedCombos = sqliteTable("saved_combos", {
  key: text("key").primaryKey(),
  ownerId: text("owner_id").notNull(),
  comboId: text("combo_id").notNull(),
  comboJson: text("combo_json").notNull(),
  status: text("status").notNull().default("research"),
  stake: real("stake").notNull().default(0),
  entryCost: real("entry_cost"),
  savedAt: text("saved_at").notNull(),
  updatedAt: text("updated_at").notNull(),
});
