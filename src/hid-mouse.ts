// import { setUint16LittleEndian, setUint16 } from "@yume-chan/no-data-view";

export class HidMouse {
    // HID descriptor for a mouse with wheel support
    static readonly Descriptor = new Uint8Array([
        0x05, 0x01,        // USAGE_PAGE (Generic Desktop)
        0x09, 0x02,        // USAGE (Mouse)
        0xa1, 0x01,        // COLLECTION (Application)
        0x09, 0x01,        //   USAGE (Pointer)
        0xa1, 0x00,        //   COLLECTION (Physical)
        0x05, 0x09,        //     USAGE_PAGE (Button)
        0x19, 0x01,        //     USAGE_MINIMUM (Button 1)
        0x29, 0x03,        //     USAGE_MAXIMUM (Button 3)
        0x15, 0x00,        //     LOGICAL_MINIMUM (0)
        0x25, 0x01,        //     LOGICAL_MAXIMUM (1)
        0x95, 0x03,        //     REPORT_COUNT (3)
        0x75, 0x01,        //     REPORT_SIZE (1)
        0x81, 0x02,        //     INPUT (Data,Var,Abs)
        0x95, 0x01,        //     REPORT_COUNT (1)
        0x75, 0x05,        //     REPORT_SIZE (5)
        0x81, 0x03,        //     INPUT (Cnst,Var,Abs)
        0x05, 0x01,        //     USAGE_PAGE (Generic Desktop)
        0x09, 0x30,        //     USAGE (X)
        0x09, 0x31,        //     USAGE (Y)
        0x09, 0x38,        //     USAGE (Wheel)
        0x15, 0x81,        //     LOGICAL_MINIMUM (-127)
        0x25, 0x7f,        //     LOGICAL_MAXIMUM (127)
        0x75, 0x08,        //     REPORT_SIZE (8)
        0x95, 0x03,        //     REPORT_COUNT (3)
        0x81, 0x06,        //     INPUT (Data,Var,Rel)
        0xc0,              //   END_COLLECTION
        0xc0               // END_COLLECTION
    ]);

    #report = new Uint8Array(4); // 1 byte buttons, 1 byte X, 1 byte Y, 1 byte wheel
    get report() {
        return this.#report;
    }

    #buttons = 0;
    #x = 0;
    #y = 0;
    #wheel = 0;

    #width: number;
    #height: number;

    constructor(width: number, height: number) {
        this.#width = width;
        this.#height = height;
    }

    setSize(width: number, height: number) {
        this.#width = width;
        this.#height = height;
        this.#x = 0;
        this.#y = 0;
    }

    move(x: number, y: number) {
        const deltaX = x - this.#x;
        const deltaY = y - this.#y;
        this.#x = x;
        this.#y = y;

        // Convert to relative movement
        this.#report[1] = Math.max(-127, Math.min(127, deltaX));
        this.#report[2] = Math.max(-127, Math.min(127, deltaY));
    }

    scroll(delta: number) {
        // Input Leap sends wheel delta as uint16, we need to convert it to int8 (-127 to 127)
        // Positive values mean scroll up, negative values mean scroll down
        const normalizedDelta = delta > 32767 ? -(65536 - delta) : delta;
        // Scale down the delta value significantly to make scrolling much smoother
        const scaledDelta = Math.round(normalizedDelta * 0.1);
        this.#wheel = Math.max(-127, Math.min(127, scaledDelta));
        this.#report[3] = this.#wheel;
    }

    buttonDown(button: number) {
        this.#buttons |= 1 << button;
        this.#report[0] = this.#buttons;
    }

    buttonUp(button: number) {
        this.#buttons &= ~(1 << button);
        this.#report[0] = this.#buttons;
    }

    resetDeltas() {
        // Reset relative movements
        this.#report[1] = 0; // X
        this.#report[2] = 0; // Y
        this.#report[3] = 0; // Wheel
    }
}