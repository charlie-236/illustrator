# Headless ComfyUI Tablet Interface: Architecture Document

## 1. System Overview
This project is a custom, tablet-optimized web frontend for an AI image generation pipeline. The heavy lifting is done by an Azure VM running ComfyUI, while the frontend UI and database run locally on a Linux desktop.

## 2. Infrastructure & Networking
The architecture bridges a local network to a cloud VM via Tailscale and PM2-managed SSH tunnels. 

* **Local Hub (`mint-pc`):**
    * Hosts the Next.js frontend, PostgreSQL database, and PM2 tunnel scripts.
    * Accessible via local Wi-Fi by the user's tablet.
* **Cloud GPU Node (`a100-core`):**
    * Azure VM (4x A100 GPUs) on Tailscale IP `100.96.99.94`.
    * Runs the ComfyUI backend on port `8188`.
    * Locked down: Binds strictly to the Tailscale network; no public internet exposure.
* **The Bridge (PM2 SSH Tunnel):**
    * Runs on `mint-pc`.
    * Command: `ssh -N -L 0.0.0.0:8188:100.96.99.94:8188 charlie@100.96.99.94`
    * *Result:* The Next.js backend on `mint-pc` communicates with ComfyUI via `http://127.0.0.1:8188` and `ws://127.0.0.1:8188/ws`.

## 3. Frontend Specifications
* **Stack:** Next.js (App Router), Tailwind CSS, Prisma (PostgreSQL).
* **Design Paradigm:** Mobile-first, dark mode, heavily optimized for iPad/Android tablet touch interactions (large buttons, responsive grids).
* **Core UI Components:**
    * **Generation Studio:** Inputs for Positive/Negative Prompts, Checkpoint/LoRA dropdowns (fetched dynamically from ComfyUI API), and sliders for CFG, Steps, Width, and Height.
    * **Live Preview:** Catches base64 preview images from the WebSocket to show generation progress.
    * **Gallery:** Displays saved images fetched from the local Postgres database, including metadata sheets (Prompts, Model, Seed).

## 4. The WebSocket "Hijack" Protocol (Critical Constraint)
**Disk space on the Azure VM (`a100-core`) is severely limited.** ComfyUI must NEVER be instructed to save final images to the remote disk.
* The Next.js API route must build a ComfyUI JSON workflow that omits the standard `SaveImage` node. 
* Instead, use a WebSocket connection to `ws://127.0.0.1:8188/ws`. 
* The Next.js server must listen for the specific `execution_success` or binary image packet streamed over the socket.
* Once intercepted, Next.js saves the physical `.png`/`.jpg` file *locally* to `mint-pc` (e.g., `/public/generations/`).

## 5. Database Schema (Prisma)
A local PostgreSQL database logs every generation. The schema must include a `Generation` table with at least the following fields:
* `id` (UUID)
* `localFilePath` (String - path to the image saved on mint-pc)
* `positivePrompt` (Text)
* `negativePrompt` (Text)
* `modelCheckpoint` (String)
* `seed` (BigInt or String)
* `cfg` (Float)
* `steps` (Int)
* `createdAt` (DateTime)

## 6. Development Workflow Rules
* Do not suggest altering the Azure VM setup; treat the `127.0.0.1:8188` endpoint as a black-box API.
* Ensure Prisma schema handles rapid, concurrent database writes effectively.
* Provide clear setup scripts for initializing the Next.js app and Prisma client.
