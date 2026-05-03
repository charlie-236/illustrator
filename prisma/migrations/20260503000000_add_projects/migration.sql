-- CreateTable: Project
CREATE TABLE "Project" (
    "id" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "description" TEXT,
    "styleNote" TEXT,
    "defaultFrames" INTEGER,
    "defaultSteps" INTEGER,
    "defaultCfg" DOUBLE PRECISION,
    "defaultWidth" INTEGER,
    "defaultHeight" INTEGER,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "Project_pkey" PRIMARY KEY ("id")
);

-- AddColumn: projectId, position to Generation
ALTER TABLE "Generation" ADD COLUMN IF NOT EXISTS "projectId" TEXT;
ALTER TABLE "Generation" ADD COLUMN IF NOT EXISTS "position" INTEGER;

-- AddForeignKey: Generation.projectId -> Project.id (SET NULL on delete)
ALTER TABLE "Generation" ADD CONSTRAINT "Generation_projectId_fkey"
    FOREIGN KEY ("projectId") REFERENCES "Project"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- CreateIndex on Generation.projectId
CREATE INDEX IF NOT EXISTS "Generation_projectId_idx" ON "Generation"("projectId");
