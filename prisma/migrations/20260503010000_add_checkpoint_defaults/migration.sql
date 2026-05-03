-- AddColumns: per-checkpoint generation defaults to CheckpointConfig
ALTER TABLE "CheckpointConfig" ADD COLUMN IF NOT EXISTS "defaultSteps" INTEGER;
ALTER TABLE "CheckpointConfig" ADD COLUMN IF NOT EXISTS "defaultCfg" DOUBLE PRECISION;
ALTER TABLE "CheckpointConfig" ADD COLUMN IF NOT EXISTS "defaultSampler" TEXT;
ALTER TABLE "CheckpointConfig" ADD COLUMN IF NOT EXISTS "defaultScheduler" TEXT;
ALTER TABLE "CheckpointConfig" ADD COLUMN IF NOT EXISTS "defaultHrf" BOOLEAN;
