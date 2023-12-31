<script lang="ts">
    import { onMount } from "svelte";
    import { get } from "svelte/store";
    import { websocket as Websocket } from "@sveu/browser";

    import { goto } from "$app/navigation";
    import DeviceItem from "$lib/components/DeviceItem.svelte";
    import LoadingSpinner from "$lib/components/LoadingSpinner.svelte";
    import Modal from "$lib/components/Modal.svelte";
    import SortableList from "$lib/components/SortableList.svelte";

    import { getAuthToken, clearAuthToken } from "$lib/auth";
    import type { Device } from "$lib/types";
    import { PUBLIC_USER_API, PUBLIC_WEBSOCKET_API } from "$env/static/public";

    // NOTE: Set low for demostration purposes, set higher for actual use
    const DEVICE_TIMEOUT = 5 * 1000; // In milliseconds

    let addDeviceId = "";
    let addDeviceName = "";

    let showAddModal = false;
    let showClipsModal = false;
    let showClipModal = false;
    let isAddingDevice = false;
    let clipsLoading = true;
    let clipLoading = true;

    let username = "";
    let devices = [] as Device[];
    let deviceIrresponsive = {} as Record<string, boolean>;
    let irresponsiveOverride = false;
    let isArmed = false;

    let cameraId = "";
    let clips = [] as string[];
    let clipName = "";
    let clipUrl = "";

    let ws: ReturnType<typeof Websocket>;
    let websocket: WebSocket;
    onMount(() => {
        const temp = connect();
        if (!temp) {
            logout();
            return;
        }

        ws = temp;
        websocket = get(ws.ws)!;
    });

    function connect(): ReturnType<typeof Websocket> | null {
        const token = getAuthToken();

        if (!token) {
            return null;
        }

        return Websocket(`${PUBLIC_WEBSOCKET_API}?token=${token}`, {
            onConnected: getInfo,
            onMessage: (_, msg) => {
                handleData(msg);
            },
            onError: logout,
        });
    }

    function handleData(msg: any) {
        msg = msg.data;
        console.log("Received message from websocket:", msg);

        let json;
        try {
            json = JSON.parse(msg) ?? {};
        } catch {
            return;
        }

        const { action, data } = json;
        if (!action || !data) {
            return;
        }

        switch (action) {
            case "get-info":
                // Initial info
                if (!username) {
                    setTimeout(() => {
                        irresponsiveOverride = true;
                    }, DEVICE_TIMEOUT);
                }

                username = data.username;
                isArmed = data.isArmed;

                devices = sortDevices(data.devices);
                saveDeviceOrder();
                break;
            case "update-device":
                const index = devices.findIndex(
                    (d) => d.deviceId === data.deviceId
                );
                if (index === -1) {
                    break;
                }

                devices[index] = {
                    ...devices[index],
                    ...data,
                };
                deviceIrresponsive[data.deviceId] = false;
                break;
            case "add-device":
                addDeviceId = data;
                isAddingDevice = false;
                break;
            case "add-device-complete":
                devices.push(data);
                devices = devices; // Needed to trigger reactivity
                saveDeviceOrder();
                deviceIrresponsive[data.deviceId] = false;

                showAddModal = false;
                addDeviceId = "";
                addDeviceName = "";
                break;
            case "list-clips":
                clipsLoading = false;
                clips = data;
                break;
            case "get-clip":
                clipUrl = data;
                clipLoading = false;
                break;
        }
    }

    function getInfo(socket: WebSocket) {
        socket.send(JSON.stringify({ action: "get-info" }));
    }

    function addDevice(socket: WebSocket, name: string) {
        if (isAddingDevice) {
            return;
        }

        isAddingDevice = true;
        addDeviceId = "";
        socket.send(JSON.stringify({ action: "add-device", data: name }));
    }

    function cancelAdd() {
        if (addDeviceId == "") {
            return;
        }

        ws?.send(
            JSON.stringify({ action: "cancel-add-device", data: addDeviceId })
        );
        isAddingDevice = false;
        addDeviceId = "";
    }

    function sortDevices(devices: Device[]): Device[] {
        const savedDevices = localStorage.getItem("deviceOrder")?.split(",");
        if (!savedDevices) {
            return devices;
        }

        // Sort the devices according to the previously saved order
        let newDevices = [] as Device[];
        for (const deviceId of savedDevices) {
            const index = devices.findIndex((d) => d.deviceId === deviceId);
            if (index === -1) continue;

            newDevices.push(devices[index]);
            devices.splice(index, 1);
        }
        // Append any remaining devices to the end
        newDevices.push(...devices);

        return newDevices;
    }

    function saveDeviceOrder() {
        localStorage.setItem(
            "deviceOrder",
            devices.map((d) => d.deviceId).join(",")
        );
    }

    function handleSort(e: CustomEvent<Device[]>) {
        devices = e.detail;
        saveDeviceOrder();
    }

    function handleClipsOpen(e: CustomEvent<number>) {
        const index = e.detail;
        const device = devices[index];

        ws?.send(
            JSON.stringify({
                action: "list-clips",
                data: device.deviceId,
            })
        );
        // Display old list while waiting, if this is the same camera
        if (cameraId === device.deviceId) {
            showClipsModal = true;
            return;
        }

        clipsLoading = true;
        cameraId = device.deviceId;
        showClipsModal = true;
    }

    function handleRemove(e: CustomEvent<number>) {
        const index = e.detail;
        const deviceId = devices[index].deviceId;
        devices.splice(index, 1);
        devices = devices; // Needed to trigger reactivity
        saveDeviceOrder();
        ws?.send(JSON.stringify({ action: "remove-device", data: deviceId }));
    }

    function handleArmToggle(event: MouseEvent) {
        const target = event.target as HTMLButtonElement;
        const newArmed =
            target?.getAttribute("aria-checked") === "true" ? false : true;

        if (newArmed) {
            const sensorsOpen = devices.some((d) => {
                if (d.type !== "contact" && d.type !== "shock") {
                    return false;
                }
                const isIrresponsive =
                    deviceIrresponsive[d.deviceId] ?? irresponsiveOverride;
                return !isIrresponsive && d.isOpen;
            });
            if (sensorsOpen) {
                alert("Cannot arm while a device is open");
                return;
            }
        }

        isArmed = newArmed;
        ws?.send(
            JSON.stringify({
                action: "set-armed",
                data: isArmed,
            })
        );
    }

    function playClip(clip: string) {
        ws?.send(
            JSON.stringify({
                action: "get-clip",
                data: clip,
            })
        );

        showClipsModal = false;

        clipName = clip.split("/")[1];
        clipLoading = true;
        showClipModal = true;
    }

    function logout() {
        const token = getAuthToken();
        clearAuthToken();
        ws?.close();

        fetch(`${PUBLIC_USER_API}/login`, {
            method: "DELETE",
            headers: {
                "Content-Type": "application/json",
                Authorization: `Bearer ${token}`,
            },
        })
            .then((res) => res.text())
            .catch((res) => {
                console.error("Failed to logout:", res);
            })
            .finally(() => {
                goto("/");
            });
    }

    function deleteAccount() {
        const token = getAuthToken();
        clearAuthToken();
        ws?.close();

        fetch(`${PUBLIC_USER_API}/`, {
            method: "DELETE",
            headers: {
                "Content-Type": "application/json",
                Authorization: `Bearer ${token}`,
            },
        })
            .then((res) => res.text())
            .catch((res) => {
                console.error("Failed to delete account:", res);
            })
            .finally(() => {
                goto("/");
            });
    }
</script>

{#if !username}
    <LoadingSpinner />
{:else}
    <Modal bind:show={showAddModal} on:close={cancelAdd}>
        {#if isAddingDevice}
            <div class="spinner-container">
                <LoadingSpinner />
            </div>
        {:else if addDeviceId !== ""}
            <div class="id-container">
                <p>Enter this ID into your device</p>
                <h1>{addDeviceId}</h1>
                <p>Please do not close this modal</p>
            </div>
        {:else}
            <form
                on:submit|preventDefault={() =>
                    addDevice(websocket, addDeviceName)}
            >
                <label for="name">Name your device</label>
                <input
                    name="name"
                    type="text"
                    placeholder="Name"
                    bind:value={addDeviceName}
                />
                <button type="submit">Add</button>
            </form>
        {/if}
    </Modal>

    <Modal bind:show={showClipsModal}>
        <div class="modal">
            {#if clipsLoading}
                <div class="spinner-container">
                    <LoadingSpinner />
                </div>
            {:else}
                <h2>
                    Clips of {devices.find((d) => d.deviceId === cameraId)
                        ?.name}
                </h2>
                {#if clips.length === 0}
                    <p>No clips</p>
                {:else}
                    <ul>
                        {#each clips as c}
                            <li on:click={() => playClip(`${cameraId}/${c}`)}>
                                {c}
                            </li>
                        {/each}
                    </ul>
                {/if}
            {/if}
        </div>
    </Modal>

    <Modal bind:show={showClipModal}>
        {#if clipLoading}
            <div class="spinner-container">
                <LoadingSpinner />
            </div>
        {:else}
            <h2>{clipName}</h2>
            <video controls height="500px">
                <source type="video/mp4" src={clipUrl} />
            </video>
        {/if}
    </Modal>

    <div class="dashboard">
        <h1>Hello, {username}!</h1>
        <SortableList
            list={devices}
            key="deviceId"
            on:sort={handleSort}
            let:item
            let:index
        >
            <DeviceItem
                {item}
                {index}
                irresponsive={deviceIrresponsive[item.deviceId] ??
                    irresponsiveOverride}
                on:click={handleRemove}
                on:open-clips={handleClipsOpen}
            />
        </SortableList>
        <div class="controls">
            <div class="slider">
                <span>Armed</span>
                <button
                    role="switch"
                    aria-checked={isArmed}
                    on:click={handleArmToggle}
                >
                </button>
            </div>
            <button on:click={() => (showAddModal = true)}>Add device</button>
            <button on:click={logout}>Logout</button>
            <button on:click={deleteAccount}>Delete account</button>
        </div>
    </div>
{/if}

<style>
    :root {
        --accent-color: CornflowerBlue;
    }

    ul {
        display: flex;
        list-style: none;
        align-items: center;
        flex-direction: column;
        padding: 0;
        min-height: 60px;
    }

    li {
        color: #ddd;
        text-decoration: underline;
    }

    li:hover {
        color: #fff;
        cursor: pointer;
    }

    form {
        display: flex;
        flex-direction: column;
        align-self: center;
        margin: 3rem;
        margin-top: 5rem;
    }

    input[type="text"] {
        padding: 0.5rem;
        border-radius: 100vw;
        margin-top: 0.5rem;
        margin-bottom: 2rem;
        border: 1px solid #ccc;
    }

    button {
        padding: 0.5rem;
        border-radius: 100vw;
        border: 1px solid #ccc;
    }

    h2 {
        align-self: center;
        text-align: center;
    }

    button:hover {
        background-color: #ccc;
    }

    form button {
        margin-top: 0.5rem;
        margin-bottom: 2rem;
    }

    .dashboard {
        display: flex;
        flex-direction: column;
        align-items: center;
        justify-content: center;
        margin: 2rem;
    }

    .id-container {
        display: flex;
        flex-direction: column;
        align-items: center;
        justify-content: center;
        margin: 3rem;
    }

    .id-container p {
        margin-bottom: 1rem;
        font-size: 28px;
    }

    .id-container h1 {
        margin-top: 0;
        font-size: 56px;
    }

    .modal {
        align-items: center;
        text-align: center;
    }

    .controls {
        display: flex;
        flex-direction: row;
    }

    .controls > * {
        margin: 0.75rem;
    }

    .slider {
        display: flex;
        align-items: center;
    }

    .slider button {
        width: 3em;
        height: 1.6em;
        position: relative;
        margin: 0 0 0 0.5em;
        background: #ccc;
        border: none;
    }

    .slider button::before {
        content: "";
        position: absolute;
        width: 1.3em;
        height: 1.3em;
        background: #fff;
        top: 0.13em;
        right: 1.5em;
        transition: transform 0.3s;
    }

    .slider button[aria-checked="true"] {
        background-color: var(--accent-color);
    }

    .slider button[aria-checked="true"]::before {
        transform: translateX(1.3em);
        transition: transform 0.3s;
    }

    .slider button:focus {
        box-shadow: 0 0px 0px 1px var(--accent-color);
    }

    .slider button {
        border-radius: 1.5em;
    }

    .slider button::before {
        border-radius: 100%;
    }

    .slider button:focus {
        box-shadow: 0 0px 8px var(--accent-color);
        border-radius: 1.5em;
    }
</style>
