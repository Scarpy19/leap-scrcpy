import { EventEmitter } from "@yume-chan/event";
import {
  getUint32BigEndian,
  setUint32BigEndian,
} from "@yume-chan/no-data-view";
import {
  BufferedReadableStream,
  ReadableStream,
} from "@yume-chan/stream-extra";
import {
  buffer,
  decodeUtf8,
  string,
  struct,
  u16,
  u32,
} from "@yume-chan/struct";

import * as net from "node:net";
import { Socket } from "node:net";
import { ClipboardChunk } from "./clipboard.js";
import { MessageType } from "./message-type.js";
import { bufferExactReadable, startsWith } from "./utils.js";

const MessageHello = struct(
  {
    versionMajor: u16,
    versionMinor: u16,
  },
  { littleEndian: false }
);

const MessageHelloBack = struct(
  {
    type: buffer(MessageType.Hello.length),
    versionMajor: u16,
    versionMinor: u16,
    name: string(u32),
  },
  { littleEndian: false }
);

const MessageInfo = struct(
  {
    type: buffer(MessageType.Info.length),
    screenX: u16,
    screenY: u16,
    screenWidth: u16,
    screenHeight: u16,
    unused: u16,
    mouseX: u16,
    mouseY: u16,
  },
  { littleEndian: false }
);

const MessageMouseMove = struct(
  {
    x: u16,
    y: u16,
  },
  { littleEndian: false }
);

const MessageMouseWheel = struct(
  {
    xDelta: u16,
    yDelta: u16,
  },
  { littleEndian: false }
);

const MessageEnter = struct(
  {
    x: u16,
    y: u16,
    sequenceNumber: u32,
    mask: u16,
  },
  { littleEndian: false }
);

async function readMessage(readable: BufferedReadableStream) {
  const buffer = await readable.readExactly(4);
  const length = getUint32BigEndian(buffer, 0);
  return await readable.readExactly(length);
}

function writeMessage(socket: Socket, message: Uint8Array) {
  const size = new Uint8Array(4);
  setUint32BigEndian(size, 0, message.length);
  socket.write(size);
  socket.write(message);
}

export class InputLeapClient {
  static readonly VersionMajor = 1;
  static readonly VersionMinor = 6;

  static async connect(
    host: string,
    port: number,
    name: string,
    width: number,
    height: number
  ) {
    const socket = new net.Socket();
    await new Promise<void>((resolve, reject) => {
      socket.connect(port, host, () => resolve());
      socket.on('error', reject);
    });

    const readable = ReadableStream.from<Uint8Array>(socket);
    const buffered = new BufferedReadableStream(readable);
    while (true) {
      const buffer = await readMessage(buffered);

      if (startsWith(buffer, MessageType.Hello)) {
        const message = MessageHello.deserialize(
          bufferExactReadable(buffer, MessageType.Hello.length)
        );

        if (
          message.versionMajor < InputLeapClient.VersionMajor ||
          (message.versionMajor === InputLeapClient.VersionMajor &&
            message.versionMinor < InputLeapClient.VersionMinor)
        ) {
          throw new Error("Incompatible version");
        }

        writeMessage(
          socket,
          MessageHelloBack.serialize({
            type: MessageType.Hello,
            versionMajor: InputLeapClient.VersionMajor,
            versionMinor: InputLeapClient.VersionMinor,
            name,
          })
        );

        continue;
      }

      if (startsWith(buffer, MessageType.InfoQuery)) {
        writeMessage(
          socket,
          MessageInfo.serialize({
            type: MessageType.Info,
            screenX: 0,
            screenY: 0,
            screenWidth: width,
            screenHeight: height,
            unused: 0,
            mouseX: 0,
            mouseY: 0,
          })
        );
        continue;
      }

      if (startsWith(buffer, MessageType.InfoAck)) {
        console.log('Input Leap server connection established');
        return new InputLeapClient(socket, buffered);
      }

      if (startsWith(buffer, MessageType.KeepAlive)) {
        writeMessage(socket, MessageType.KeepAlive);
        continue;
      }

      const type = decodeUtf8(buffer.subarray(0, 4));
      console.log("Received", "Unknown", type);
    }
  }

  #socket: Socket;
  #keepAliveTimeout: NodeJS.Timeout;

  #lastSequenceNumber = 0;
  #clipboard = new ClipboardChunk();

  #onEnter = new EventEmitter<{
    x: number;
    y: number;
    sequenceNumber: number;
    mask: number;
  }>();
  get onEnter() {
    return this.#onEnter.event;
  }

  #onLeave = new EventEmitter<void>();
  get onLeave() {
    return this.#onLeave.event;
  }

  #onMouseMove = new EventEmitter<{ x: number; y: number }>();
  get onMouseMove() {
    return this.#onMouseMove.event;
  }

  #onMouseDown = new EventEmitter<number>();
  get onMouseDown() {
    return this.#onMouseDown.event;
  }

  #onMouseUp = new EventEmitter<number>();
  get onMouseUp() {
    return this.#onMouseUp.event;
  }

  #onMouseWheel = new EventEmitter<{ xDelta: number; yDelta: number }>();
  get onMouseWheel() {
    return this.#onMouseWheel.event;
  }

  #onClipboard = new EventEmitter<string>();
  get onClipboard() {
    return this.#onClipboard.event;
  }

  #lastClipboard = "";

  constructor(socket: Socket, readable: BufferedReadableStream) {
    this.#socket = socket;

    socket.on('close', () => {
      console.log('Input Leap server connection ended');
    });

    this.#keepAliveTimeout = setTimeout(() => {
      this.#writeMessage(MessageType.KeepAlive);
    }, 3000);
    this.#keepAliveTimeout.unref();

    (async () => {
      while (true) {
        const buffer = await readMessage(readable);

        if (startsWith(buffer, MessageType.Enter)) {
          const message = MessageEnter.deserialize(
            bufferExactReadable(buffer, MessageType.Enter.length)
          );
          this.#lastSequenceNumber = message.sequenceNumber;
          this.#onEnter.fire({
            x: message.x,
            y: message.y,
            sequenceNumber: message.sequenceNumber,
            mask: message.mask,
          });
          continue;
        }

        if (startsWith(buffer, MessageType.Leave)) {
          this.#onLeave.fire();
          continue;
        }

        if (startsWith(buffer, MessageType.MouseMove)) {
          const message = MessageMouseMove.deserialize(
            bufferExactReadable(buffer, MessageType.MouseMove.length)
          );
          this.#onMouseMove.fire({ x: message.x, y: message.y });
          continue;
        }

        if (startsWith(buffer, MessageType.MouseDown)) {
          const button = buffer[MessageType.MouseDown.length + 1];
          this.#onMouseDown.fire(button);
          continue;
        }

        if (startsWith(buffer, MessageType.MouseUp)) {
          const button = buffer[MessageType.MouseUp.length + 1];
          this.#onMouseUp.fire(button);
          continue;
        }

        if (startsWith(buffer, MessageType.MouseWheel)) {
          const message = MessageMouseWheel.deserialize(
            bufferExactReadable(buffer, MessageType.MouseWheel.length)
          );
          this.#onMouseWheel.fire({
            xDelta: message.xDelta,
            yDelta: message.yDelta
          });
          continue;
        }

        if (startsWith(buffer, MessageType.Clipboard)) {
          const result = this.#clipboard.write(buffer);
          if (result && result !== this.#lastClipboard) {
            this.#lastClipboard = result;
            this.#onClipboard.fire(result);
          }
          continue;
        }

        if (startsWith(buffer, MessageType.ClipboardOperation) ||
          startsWith(buffer, MessageType.ScreenOperation)) {
          // These operations are currently not implemented but acknowledged
          continue;
        }

        if (
          startsWith(buffer, MessageType.KeepAlive) ||
          startsWith(buffer, MessageType.InfoAck)
        ) {
          continue;
        }

        const type = decodeUtf8(buffer.subarray(0, 4));
        console.log("Received", "Unknown", type);
      }
    })();
  }

  #writeMessage(message: Uint8Array) {
    writeMessage(this.#socket, message);
    this.#keepAliveTimeout.refresh();
  }

  setSize(width: number, height: number) {
    this.#writeMessage(
      MessageInfo.serialize({
        type: MessageType.Info,
        screenX: 0,
        screenY: 0,
        screenWidth: width,
        screenHeight: height,
        unused: 0,
        mouseX: 0,
        mouseY: 0,
      })
    );
  }

  setClipboard(data: string) {
    if (!this.#lastSequenceNumber) {
      return;
    }

    if (data === this.#lastClipboard) {
      return;
    }
    this.#lastClipboard = data;

    for (const chunk of ClipboardChunk.serialize(
      this.#lastSequenceNumber,
      data
    )) {
      this.#writeMessage(chunk);
    }
  }
}

