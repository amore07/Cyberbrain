let cl = console.log;

function debugLog(...messages) {
  // isDevMode is set in webview.ts
  if (isDevMode) {
    messages.forEach(msg => console.log(msg));
  }
}

function assert(condition, message) {
  if (!condition) {
    throw new Error(message || "Assertion failed");
  }
}

export class Loop {
  constructor(startOffset, endOffset, startLineno, endLineno) {
    this.startOffset = startOffset;
    this.endOffset = endOffset;
    this.startLineno = startLineno;
    this.endLineno = endLineno;
    this.counter = 0;
    this.parent = undefined;
    this.children = new Set();
    this.id = `loop@line${startLineno}`;

    // Note that the number of iterations != maxCounter
    //
    // for i in range(2):
    //   for j in range(2):
    //
    // For the inner loop, number of iterations is 4, but maxCounter is 1.
    this.maxCounter = 0;

    // Maps counter to index of the first and last event in each iteration of this loop.
    // Note that the counter includes parent's counter, like [0,0,1]
    this._iterationStarts = new Map();
    this._iterationEnds = new Map();
  }

  incrementCounter() {
    this.counter++;
    this.maxCounter = Math.max(this.counter, this.maxCounter);
  }

  addIterationStart(counters, eventIndex) {
    // We can't use array as keys directly, since we don't keep the array objects.
    this._iterationStarts.set(counters.toString(), eventIndex);
  }

  addIterationEnd(counters, eventIndex) {
    this._iterationEnds.set(counters.toString(), eventIndex);
  }

  get currentIterationStart() {
    return this._iterationStarts.get(this.getCounters().toString());
  }

  get currentIterationEnd() {
    return this._iterationEnds.get(this.getCounters().toString());
  }

  /* Calculates the counters array from top-level loop to the modified loop.
   *  Outer loop's counter will precedes inner loops'.
   */
  getCounters() {
    let counters = [this.counter];
    let parentLoop = this.parent;
    while (parentLoop !== undefined) {
      counters.unshift(parentLoop.counter);
      parentLoop = parentLoop.parent;
    }
    return counters;
  }
}

/*
Given an array of loops, return an array represent their counters, e.g.
[loop(counter: 1), loop(counter: 2)] -> [1, 2]
 */
function getCountersArray(loopStack) {
  return loopStack.map(loop => loop.counter);
}

// TODO: Learn from
//   https://github.com/cuthbertLab/jsonpickleJS/blob/master/js/unpickler.js
//   and implement a better version of decode.
//   Maybe use https://stackoverflow.com/a/46132163.
function decodeJson(jsonString) {
  try {
    return JSON.parse(jsonString);
  } catch (error) {
    cl(error);
    cl(jsonString);
  }
}

/*
Class that
- Manage raw events and loops, including loops' state.
- Calculates the currently visible events.

 */
export class TraceData {
  constructor(data) {
    this.frameMetadata = data.metadata;
    this.events = data.events;
    this.events.forEach(event => {
      if (event.hasOwnProperty("value")) {
        event.value = decodeJson(event.value); // Previously a JSON string.
      }
    });
    this.loops = data.loops
      .map(
        loop =>
          new Loop(
            loop.startOffset,
            loop.endOffset,
            loop.startLineno,
            loop.endLineno
          )
      )
      .sort((loop1, loop2) => loop1.startOffset - loop2.startOffset);
    this.tracingResult = new Map(Object.entries(data.tracingResult));
    // Level represents the hierarchy in the tree view.
    this.linenoToLevel = new Map();
    this.visibleEvents = new Map();
    this.initialize();
  }

  get visibleEventsArray() {
    return Array.from(this.visibleEvents.values());
  }

  /**
   * Initialize the trace graph.
   * Fills this.loops and this.visibleEvents
   */
  initialize() {
    let loopStack = [];
    let maxReachedOffset = -1;
    let previousOffset = -2;
    let appearedLineNumbers = new Set();

    for (let event of this.events) {
      const nextEventIndex = event.index + 1;
      const offset = event.offset;
      const lineno = event.lineno;
      appearedLineNumbers.add(event.lineno);

      // For initial state, all loop counters are 0, thus visible events should form a
      // sequence in which the next event always has a larger offset than the previous one.
      //
      // Note that we use >= instead of >. This is because we may have two nodes of the
      // same offset. e.g.
      //
      //    nonlocal a
      //    a = 1
      //
      // In this case, the initial value event and binding event has the same offset because
      // they are both triggered by the STORE_DEREF instruction.
      if (offset >= maxReachedOffset) {
        maxReachedOffset = offset;

        // Don't include JumpBackToLoopStart in visible events.
        if (event.type !== "JumpBackToLoopStart") {
          this.visibleEvents.set(offset, event);
        }
      }

      // Pops loop out of the stack.
      if (
        loopStack.length > 0 &&
        loopStack[loopStack.length - 1].endLineno < lineno
      ) {
        loopStack[loopStack.length - 1].addIterationEnd(
          getCountersArray(loopStack),
          event.index - 1 // The previous event is the last event of the last iteration.
        );
        loopStack.pop().counter = 0;
      }

      // We need to take all cases into consideration when adding iteration ends.
      // It's fine if an iteration end is added multiple times, because we use a map to
      // store it.

      // Case 1: current event is an early return from inside the loop, e.g.
      //   while a:
      //     if b:
      //       return
      //     do_something()
      if (event.type === "Return" && loopStack.length > 0) {
        loopStack[loopStack.length - 1].addIterationEnd(
          getCountersArray(loopStack),
          event.index
        );
      }

      // Case 2: a loop's end is the last event of a frame.
      if (
        loopStack.length > 0 &&
        loopStack[loopStack.length - 1].endLineno === lineno
      ) {
        loopStack[loopStack.length - 1].addIterationEnd(
          getCountersArray(loopStack),
          event.index
        );
      }

      // Case 3: next event has a smaller offset than the current event, representing
      // a jump back. Thus, current event is an iteration's end, next event is next
      // iteration's start.
      if (
        loopStack.length > 0 &&
        event.type === "JumpBackToLoopStart" &&
        event.index < this.events.length - 1 &&
        this.events[nextEventIndex].offset < offset
      ) {
        let currentLoop = loopStack[loopStack.length - 1];
        currentLoop.addIterationEnd(getCountersArray(loopStack), event.index);
        currentLoop.incrementCounter();
        currentLoop.addIterationStart(
          getCountersArray(loopStack),
          nextEventIndex // The event following JumpBackToLoopStart is next iteration's start.
        );
      }

      // Pushes loop onto the stack.
      for (let loop of this.loops) {
        // For while loops, there's no event at the line of loop counter,
        // so we need to add it as well. See #92
        appearedLineNumbers.add(loop.startLineno);

        if (
          previousOffset < loop.startOffset &&
          loop.startOffset <= offset &&
          lineno <= loop.endLineno
        ) {
          if (loopStack.length > 0 && loop.parent === undefined) {
            let innerMostLoop = loopStack[loopStack.length - 1];
            innerMostLoop.children.add(loop);
            loop.parent = innerMostLoop;
          }
          loopStack.push(loop);
          loop.addIterationStart(
            loopStack.map(loop => loop.counter),
            event.index
          );
        }
      }
      previousOffset = offset;
    }

    // Restores to the initial state.
    for (let loop of this.loops) {
      loop.counter = 0;
    }

    // There's space for improvements for building linenoMapping.
    //
    // The easiest one being, if line range is small, just use the original lineno as level.
    //
    // Another idea is to recalculate distance and make them smaller.
    // for example, distance [1, 2] becomes 1, [3, 5] becomes 2, > 5 becomes 3.
    Array.from(appearedLineNumbers)
      .sort((a, b) => a - b)
      .forEach((lineno, level) => {
        this.linenoToLevel.set(lineno, level + 1); // Level starts with 1, leaving level 0 to InitialValue nodes
      });
  }

  /**
   * Update visible events upon changing loop counters.
   * @param {Loop} modifiedLoop - The loop whose counter is changed by users.
   */
  updateVisibleEvents(modifiedLoop) {
    // Loops are already sorted by start offset, so inner loops are guaranteed to come
    // later and override events from outer loops.
    for (const loop of this.loops) {
      for (
        let i = loop.currentIterationStart;
        i <= loop.currentIterationEnd;
        i++
      ) {
        const event = this.events[i];
        if (event.type !== "JumpBackToLoopStart") {
          this.visibleEvents.set(event.offset, event);
        }
      }
    }

    assert(
      modifiedLoop !== undefined,
      "modifiedLoop is required to be passed to updateVisibleEvents !"
    );

    // Remove invalid nodes, aka nodes that are not supposed to be displayed.
    for (let [offset, event] of this.visibleEvents) {
      const lineno = event.lineno;
      if (
        lineno <= modifiedLoop.startLineno ||
        lineno >= modifiedLoop.endLineno
      ) {
        // Nodes not within the offset range of the modified loop is not affected.
        continue;
      }

      if (
        event.index < modifiedLoop.currentIterationStart ||
        event.index > modifiedLoop.currentIterationEnd
      ) {
        // Node is in the offset range of the modified loop, but not within the index
        // range of the current iteration. This indicates that it is an invalid node.
        this.visibleEvents.delete(offset);
      }
    }
  }
}
