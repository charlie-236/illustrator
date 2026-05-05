# Headless ComfyUI Tablet Interface: Architecture Document

## 1. System Overview
This project is a custom, tablet-optimized web frontend for an AI image generation pipeline. The heavy lifting is done by a GPU VM running ComfyUI, while the frontend UI and database run locally on a Linux desktop.

## 2. Infrastructure & Networking
The architecture bridges a local network to a cloud VM via PM2-managed SSH tunnels.

* **Local Hub:**
    * Hosts the Next.js frontend, PostgreSQL database, and PM2 tunnel scripts.
    * Accessible via local Wi-Fi by the user's tablet.
* **Cloud GPU Node:**
    * VM running ComfyUI on port `8188`.
    * Reached only via the local SSH tunnel — never contacted directly from Next.js.
* **The Bridge (PM2 SSH Tunnel):**
    * Runs on the local machine.
    * Command: `ssh -N -L 0.0.0.0:8188:<gpu-vm-ip>:8188 <your-vm-user>@<gpu-vm-ip>`
    * *Result:* The Next.js backend communicates with ComfyUI via `http://127.0.0.1:8188` and `ws://127.0.0.1:8188/ws`.

## 3. Frontend Specifications
* **Stack:** Next.js (App Router), Tailwind CSS, Prisma (PostgreSQL).
* **Design Paradigm:** Mobile-first, dark mode, heavily optimized for iPad/Android tablet touch interactions (large buttons, responsive grids).
* **Core UI Components:**
    * **Generation Studio:** Inputs for Positive/Negative Prompts, Checkpoint/LoRA dropdowns (fetched dynamically from ComfyUI API), and sliders for CFG, Steps, Width, and Height.
    * **Live Preview:** Catches base64 preview images from the WebSocket to show generation progress.
    * **Gallery:** Displays saved images fetched from the local Postgres database, including metadata sheets (Prompts, Model, Seed).

## 4. The WebSocket "Hijack" Protocol (Critical Constraint)
**Disk space on the GPU VM is severely limited.** ComfyUI must NEVER be instructed to save final images to the remote disk.
* The Next.js API route must build a ComfyUI JSON workflow that omits the standard `SaveImage` node. 
* Instead, use a WebSocket connection to `ws://127.0.0.1:8188/ws`. 
* The Next.js server must listen for the specific `execution_success` or binary image packet streamed over the socket.
* Once intercepted, Next.js saves the physical `.png`/`.jpg` file *locally* to the local machine (configured via `IMAGE_OUTPUT_DIR` in `.env`).

## 5. Database Schema (Prisma)
A local PostgreSQL database logs every generation. The schema must include a `Generation` table with at least the following fields:
* `id` (UUID)
* `localFilePath` (String - path to the image saved locally)
* `positivePrompt` (Text)
* `negativePrompt` (Text)
* `modelCheckpoint` (String)
* `seed` (BigInt or String)
* `cfg` (Float)
* `steps` (Int)
* `createdAt` (DateTime)

## 6. Development Workflow Rules
* Do not suggest altering the GPU VM setup; treat the `127.0.0.1:8188` endpoint as a black-box API.
* Ensure Prisma schema handles rapid, concurrent database writes effectively.
* Provide clear setup scripts for initializing the Next.js app and Prisma client.
