-- AlterTable
ALTER TABLE "school" ADD COLUMN     "matricule_prefix" TEXT NOT NULL DEFAULT 'BSPS',
ADD COLUMN     "matricule_include_year" BOOLEAN NOT NULL DEFAULT true,
ADD COLUMN     "matricule_digits" INTEGER NOT NULL DEFAULT 3,
ADD COLUMN     "matricule_separator" TEXT NOT NULL DEFAULT '-';
