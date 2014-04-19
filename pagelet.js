/*globals */
'use strict';

var EventEmitter = require('eventemitter3')
  , collection = require('./collection')
  , Fortress = require('fortress')
  , async = require('./async')
  , sandbox;

/**
 * Representation of a single pagelet.
 *
 * @constructor
 * @param {Pipe} pipe The pipe.
 * @api public
 */
function Pagelet(pipe) {
  EventEmitter.call(this);

  this.orchestrate = pipe.orchestrate;
  this.stream = pipe.stream;
  this.pipe = pipe;

  //
  // Create one single Fortress instance that orchestrates all iframe based client
  // code. This sandbox variable should never be exposed to the outside world in
  // order to prevent leaking.
  //
  this.sandbox = sandbox = sandbox || new Fortress;
}

//
// Inherit from EventEmitter.
//
Pagelet.prototype = new EventEmitter();
Pagelet.prototype.constructor = Pagelet;

/**
 * Configure the Pagelet.
 *
 * @param {String} name The given name of the pagelet.
 * @param {Object} data The data of the pagelet.
 * @api private
 */
Pagelet.prototype.configure = function configure(name, data) {
  var pagelet = this;

  this.placeholders = this.$('data-pagelet', name);

  //
  // Pagelet identification.
  //
  this.id = data.id;
  this.name = name;

  //
  // The pagelet
  //
  if (data.remove) {
    return this.destroy(true);
  }

  //
  // Attach event listeners for FORM posts so we can intercept those.
  //
  this.submit();

  //
  // Create a real-time Substream over which we can communicate over without.
  //
  this.substream = this.stream.substream(this.name);
  this.substream.on('data', function data(packet) {
    pagelet.processor(packet);
  });

  //
  // Register the pagelet with the BigPipe server as an indication that we've
  // been fully loaded and ready for action.
  //
  this.orchestrate.write({ type: 'pagelet', name: name });

  this.css = collection.array(data.css);    // CSS for the Page.
  this.js = collection.array(data.js);      // Dependencies for the page.
  this.run = data.run;                      // Pagelet client code.
  this.rpc = data.rpc;                      // Pagelet RPC methods.
  this.data = data.data;                    // All the template data.
  this.container = this.sandbox.create();   // Create an application sandbox.
  this.timeout = data.timeout || 25 * 1000; // Resource loading timeout.

  //
  // Generate the RPC methods that we're given by the server. We will make the
  // assumption that:
  //
  // - A callback function is always given as last argument.
  // - The function should return it self in order to chain.
  // - The function given supports and uses error first callback styles.
  // - Does not override the build-in prototypes of the Pagelet.
  //
  collection.each(this.rpc, function rpc(method) {
    var counter = 0;

    //
    // Never override build-in methods as this WILL affect the way a Pagelet is
    // working.
    //
    if (method in Pagelet.prototype) return;

    pagelet[method] = function rpcfactory() {
      var args = Array.prototype.slice.call(arguments, 0)
        , id = method +'#'+ (++counter);

      pagelet.once('rpc::'+ id, args.pop());
      pagelet.substream.write({ method: method, type: 'rpc', args: args, id: id });

      return pagelet;
    };
  });

  //
  // Should be called before we create `rpc` hooks.
  //
  this.broadcast('configured', data);

  async.each(this.css.concat(this.js), function download(asset, next) {
    this.load(document.body, asset, next);
  }, function done(err) {
    if (err) return pagelet.emit('error', err);
    pagelet.emit('loaded');

    pagelet.render(pagelet.parse());
    pagelet.initialise();
  }, { context: this.pipe, timeout: this.timeout });
};

/**
 * Intercept form posts and stream them over our substream instead to prevent
 * full page reload.
 *
 * @returns {Pagelet}
 * @api private
 */
Pagelet.prototype.submit = function submit() {
  var pagelet = this;

  /**
   * Handles the actual form submission.
   *
   * @param {Event} evt The submit event.
   */
  function submission(evt) {
    var form = evt.target || evt.srcElement;

    //
    // In previous versions we had and `evt.preventDefault()` so we could make
    // changes to the form and re-submit it. But there's a big problem with that
    // and that is that in FireFox it loses the reference to the button that
    // triggered the submit. If causes buttons that had a name and value:
    //
    // ```html
    // <button name="key" value="value" type="submit">submit</button>
    // ```
    //
    // To be missing from the POST or GET. We managed to go around it by not
    // simply preventing the default action. If this still does not not work we
    // need to transform the form URLs once the pagelets are loaded.
    //
    if ('getAttribute' in form && form.getAttribute('data-pagelet-async') === 'false') {
      var action = form.getAttribute('action');
      return form.setAttribute('action', [
        action,
        ~action.indexOf('?') ? '&' : '?',
        '_pagelet=',
        name
      ].join(''));
    }

    //
    // As we're submitting the form over our real-time connection and gather the
    // data our self we can safely prevent default.
    //
    evt.preventDefault();
    pagelet.post(form);
  }

  collection.each(this.placeholders, function each(root) {
    root.addEventListener('submit', submission, false);
  });

  //
  // When the pagelet is removed we want to remove our listeners again. To
  // prevent memory leaks as well possible duplicate listeners when a pagelet is
  // loaded in the same placeholder (in case of a full reload).
  //
  this.once('destroy', function destroy() {
    collection.each(pagelet.placeholders, function each(root) {
      root.removeEventListener('submit', submission, false);
    });
  });

  return this;
};

/**
 * Post the contents of a <form> to the server.
 *
 * @param {FormElement} form Form that needs to be posted.
 * @returns {Object} The data that is ported to the server.
 * @api public
 */
Pagelet.prototype.post = function post(form) {
  var active = document.activeElement
  , elements = form.elements
  , data = {}
  , element
  , i;

  if (active && active.name) {
    data[active.name] = active.value;
  } else {
    active = false;
  }

  for (i = 0; i < elements.length; i++) {
    element = elements[i];

    //
    // Story time children! Once upon a time there was a developer, this
    // developer created a form with a lot of submit buttons. The developer
    // knew that when a user clicked on one of those buttons the value="" and
    // name="" attributes would get send to the server so he could see which
    // button people had clicked. He implemented this and all was good. Until
    // someone captured the `submit` event in the browser which didn't have
    // a reference to the clicked element. This someone found out that the
    // `document.activeElement` pointed to the last clicked element and used
    // that to restore the same functionality and the day was saved again.
    //
    // There are valuable lessons to be learned here. Submit buttons are the
    // suck. PERIOD.
    //
    if (
         !element.name
      || element.name in data
      || (active && active.name === element.name)) continue;

    // @TODO handle file uploads
    data[element.name] = element.value;
  }

  //
  // Now that we have a JSON object, we can just send it over our real-time
  // connection and wait for a page refresh.
  //
  this.substream.write({
    type: (form.method || 'GET').toLowerCase(),
    body: data
  });

  return data;
};

/**
 * Process the incoming messages from our SubStream.
 *
 * @param {Object} packet The decoded message.
 * @api private
 */
Pagelet.prototype.processor = function processor(packet) {
  switch (packet.type) {
    case 'rpc':
      this.emit.apply(this, ['rpc::'+ packet.id].concat(packet.args || []));
    break;

    case 'event':
      if (packet.args && packet.args.length) {
        this.emit.apply(this, packet.args);
      }
    break;

    case 'fragment':
      this.render(packet.frag.view);
    break;
  }
};

/**
 * The pagelet's resource has all been loaded.
 *
 * @api private
 */
Pagelet.prototype.initialise = function initialise() {
  this.broadcast('initialise');

  //
  // Only load the client code in a sandbox when it exists. There no point in
  // spinning up a sandbox if it does nothing
  //
  if (!this.code) return;
  this.sandbox(this.prepare(this.code));
};

/**
 * Broadcast an event that will be emitted on the pagelet and the page.
 *
 * @param {String} event The name of the event we should emit
 * @returns {Pagelet}
 * @api public
 */
Pagelet.prototype.broadcast = function broadcast(event) {
  this.emit.apply(this, arguments);
  this.pipe.emit.apply(this.pipe, [
    this.name +'::'+ event,
    this
  ].concat(Array.prototype.slice.call(arguments, 1)));

  return this;
};

/**
 * Find the element based on the attribute and value.
 *
 * @param {String} attribute The name of the attribute we're searching.
 * @param {String} value The value that the attribute should equal to.
 * @returns {Array} A list of HTML elements that match.
 * @api public
 */
Pagelet.prototype.$ = function $(attribute, value) {
  if (document && 'querySelectorAll' in document) {
    return Array.prototype.slice.call(
        document.querySelectorAll('['+ attribute +'="'+ value +'"]')
      , 0
    );
  }

  //
  // No querySelectorAll support, so we're going to do a full DOM scan.
  //
  var all = document.getElementsByTagName('*')
    , length = all.length
    , results = []
    , i = 0;

  for (; i < length; i++) {
    if (value === all[i].getAttribute(attribute)) {
      results.push(all[i]);
    }
  }

  return results;
};

/**
 * Render the HTML template in to the placeholders.
 *
 * @param {String} html The HTML that needs to be added in the placeholders.
 * @returns {Boolean} Successfully rendered a pagelet.
 * @api private
 */
Pagelet.prototype.render = function render(html) {
  if (!this.placeholders.length || !html) return false;

  collection.each(this.placeholders, function each(root) {
    var fragment = document.createDocumentFragment()
      , div = document.createElement('div')
      , borked = this.pipe.IEV < 7;

    //
    // Clean out old HTML before we append our new HTML or we will get duplicate
    // DOM. Or there might have been a loading placeholder in place that needs
    // to be removed.
    //
    while (root.firstChild) {
      root.removeChild(root.firstChild);
    }

    if (borked) root.appendChild(div);

    div.innerHTML = html;

    while (div.firstChild) {
      fragment.appendChild(div.firstChild);
    }

    root.appendChild(fragment);
    if (borked) root.removeChild(div);
  }, this);

  this.broadcast('render', html);
  return true;
};

/**
 * Parse the included template from the comment node so it can be injected in to
 * the page as initial rendered view.
 *
 * @returns {String} View.
 * @api private
 */
Pagelet.prototype.parse = function parse() {
  var node = this.$('data-pagelet-fragment', this.name)[0]
    , comment;

  //
  // The firstChild of the fragment should have been a HTML comment, this is to
  // prevent the browser from rendering and parsing the template.
  //
  if (!node.firstChild || node.firstChild.nodeType !== 8) return;

  comment = node.firstChild.nodeValue;

  return comment
    .substring(1, comment.length -1)
    .replace(/\\([\s\S]|$)/g, '$1');
};

/**
 * Destroy the pagelet and clean up all references so it can be re-used again in
 * the future.
 *
 * @TODO unload CSS
 * @TODO unload JavaScript
 *
 * @param {Boolean} remove Remove the placeholder as well.
 * @api public
 */
Pagelet.prototype.destroy = function destroy(remove) {
  var pagelet = this;

  this.emit('destroy'); // Execute any extra destroy hooks.

  //
  // Remove all the HTML from the placeholders.
  //
  if (this.placeholders) collection.each(this.placeholders, function remove(root) {
    if (remove && root.parentNode) root.parentNode.removeChild(root);
    else while (root.firstChild) root.removeChild(root.firstChild);
  });

  //
  // Remove the added RPC handlers, make sure we don't delete prototypes.
  //
  if (this.rpc && this.rpc.length) collection.each(this.rpc, function nuke(method) {
    if (method in Pagelet.prototype) return;
    delete pagelet[method];
  });

  //
  // Remove the sandboxing.
  //
  if (this.container) sandbox.kill(this.container.id);
  this.placeholders = this.container = null;

  //
  // Announce the destruction and remove it.
  //
  if (this.substream) this.substream.end({
    type: 'end'
  });

  //
  // Everything has been cleaned up, release it to our Freelist Pagelet pool.
  //
  this.pipe.free(this);

  return this;
};

//
// Expose the module.
//
module.exports = Pagelet;
