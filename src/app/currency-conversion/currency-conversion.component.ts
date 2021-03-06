import { Component, Inject, OnInit, ElementRef, ViewChild } from '@angular/core';
import { FormControl, Validators } from '@angular/forms';
import { ActivatedRoute } from '@angular/router';

import { Observable, Subscription, BehaviorSubject } from 'rxjs';
import { map, startWith } from 'rxjs/operators';

import { CurrencyConversionService } from '../currency-conversion.service';
import { CurrencyMetadata } from '../currency-info.data';

import { CurrencyValidator } from '../currency-validator.directive';

import { MatDialog, MatDialogRef, MAT_DIALOG_DATA } from '@angular/material/dialog';

import * as mtz from 'moment-timezone';

/**
 * Local enum representing the loading state of the converter
 **/
enum ConverterState {
  /* Currency conversion service is fetching available currency codes */
  fetchingCurrencies = 'fetchingCurrencies',
  /* Currency conversion service is fetching historical rate information */
  fetchingExchangeRates = 'fetchingExchangeRates',
  /* Component is ready to convert currencies */
  ready = 'ready',
  /* An error occurred while loading external data */
  loadingError = 'loadingError',
}

/**
 * A dialog used by `CurrencyConversionComponent` to prompt the user to check for new rates.
 **/
@Component({
  selector: 'dialog-prompt-rate-check',
  template: `
<h1 mat-dialog-title>New rates are available</h1>
<div mat-dialog-content>
  <p>The Bank of Canada publishes new rates every day at 16:30 ET</p>
  <p>Would you like to fetch the new rates?</p>
</div>
<div mat-dialog-actions>
<button mat-flat-button [mat-dialog-close]="true">Fetch new rates</button>
<button mat-flat-button [mat-dialog-close]="false">Not now</button>
</div>
  `,
})
export class DialogPromptRateCheck implements OnInit {
  constructor(
    public dialogRef: MatDialogRef<DialogPromptRateCheck>,
    @Inject(MAT_DIALOG_DATA) public data : any
  ) {}

  ngOnInit() {}
}

/**
 * The main component which wraps up all the logic needed to perform and display currency conversions.
 **/
@Component({
  selector: 'app-currency-conversion',
  templateUrl: './currency-conversion.component.html',
  styleUrls: ['./currency-conversion.component.css'],
})
export class CurrencyConversionComponent implements OnInit {
  /* Input field for amount of foreign currency to be converted */
  @ViewChild('inputFX') inputFX: ElementRef;
  /* Input field for amount of Canadian currency to be converted */
  @ViewChild('inputCAD') inputCAD: ElementRef;

  /* Used to communicate loading state aynchronously to template */
  currentStateSubject : BehaviorSubject<string> = new BehaviorSubject<string>("");
  currentStateObs : Observable<string> = this.currentStateSubject.asObservable();

  /* Options for foreign currency conversions (e.g. 'CAD', 'USD', 'EUR') */
  options : CurrencyMetadata[] = [];

  /* Form control for selecting a foreign currency */
  fxCurrencyControl = new FormControl('', [CurrencyValidator()]);
  /* Based on user input in foreign currency field, options that still match */
  filteredOptions: Observable<CurrencyMetadata[]>;

  /* regex for valid entries of currency amount */
  amountPattern = "^(0|([1-9][0-9]*))(\.[0-9]{1,4})?$";

  /* Form controls for amount inputs */
  fxAmountControl = new FormControl(
    {value: '', disabled: true},
    [Validators.pattern(this.amountPattern)]
  );
  cadAmountControl = new FormControl(
    {value: '', disabled: true},
    [Validators.pattern(this.amountPattern)]
  );

  /* Form control for selecting a date for the conversion */
  dateControl = new FormControl({value: null, disabled: true});
  /* BoC doesn't publish rates every day */
  validConversionDates : Date[] = [];
  /* used to limit range of selectable dates */
  minDate : Date;
  maxDate : Date;

  /* tuple: [fromCode, toCode, conversionRate, conversionRateDate], last conversion made */
  lastConversion : [string, string, number, Date] | null = null;

  /* Has the user selected a valid foreign currency yet? */
  _foreignSelected = false;
  /* Which foreign currency the user has selected */
  foreignSelection : CurrencyMetadata | null = null;
  /* Is the user converting to CAD? */
  toCAD = true;

  /**
   * The component can restart if new rates are available, so we track subscriptions made so that they can be
   * unsubscribed before restarting.
   **/
  valueChangeSubscriptions : Subscription[] = [];

  /* Time at which BoC rates were last fetched */
  easternTimeLastRateFetch : Date | null = null;
  /* Stores the interval timer handle used to check for rate updates */
  rateUpdateInterval : any | null = null;
  /* How many seconds to wait before checking if updated conversion rates are available */
  rateUpdateTimeout = 60 * 1000;
  /* Time after which new rates become available on weekdays */
  fetchRatesAfterHour = 16;
  fetchRatesAfterMinute = 30;
  /* If the user declines to fetch new rates */
  userSkippedRateRefresh = false;
  /* Can be set by adding query parameter `/?forceUpdatePrompt=true`, used to test the prompt */
  _forceUpdatePrompt : boolean = false;

  constructor(
    private conversionService: CurrencyConversionService,
    private newRatesPrompt : MatDialog,
    private route: ActivatedRoute,
  ) {
    // We do this in the constructor, because ngOnInit() will be called multiple times, and we only want to allow the
    // functionality to be tested once.
    this.route.queryParams.subscribe(params => {
      if (params['forceUpdatePrompt']) {
        console.log("forcing rate update prompt");
        this._forceUpdatePrompt = true;
      }
    });
  }

  ngOnInit(): void {
    /**
     * Note: this function will get called:
     *
     * 1. when the component is initiated as a result of visiting its route ("/"), OR
     * 2. when the user is prompted to refresh the conversion rates at 16:30 ET on a weekday, and they agree to do so
     **/
    let currencies = this.conversionService.getAll();
    this.options = currencies;
    this.state = ConverterState.fetchingCurrencies;
    this.foreignSelected = false;
    this.foreignSelection = null;
    this.fxCurrencyControl.reset({value: '', disabled: false});
    this.fxAmountControl.reset({value: '', disabled: true});
    this.cadAmountControl.reset({value: '', disabled: true});
    this.dateControl.reset();
    this.userSkippedRateRefresh = false;

    /**
     * Because ngOnInit() could be called again later (see above), we will push any valueChanges subscriptions we make
     * to an array, so that we can .unsubscribe() from all of them before calling ngOnInit() again (otherwise the old
     * subscription handlers will be reacting to improperly initialized values)
     **/

    /* When the foreign currency field changes, we want to catch when a valid selection has been made */
    this.valueChangeSubscriptions.push(
      this.fxCurrencyControl.valueChanges.subscribe(value => {
        if (typeof value == "object") {
          // UI should react to a valid currency being selected
          this.foreignSelected = true;
          // and should know which currency is selected
          this.foreignSelection = value;
          // initially we will always convert TO CAD first
          this.toCAD = true;

          // Select the foreign currency amount input (as a convenience to the user)
          setTimeout(() => {this.inputFX.nativeElement.focus();}, 0);
        } else {
          // The user may have backspaced a valid currency name, so we will make the UI react accordingly
          this.foreignSelected = false;
          this.fxAmountControl.setValue('', {emitEvent: false});
          this.fxAmountControl.disable();
          this.cadAmountControl.setValue('', {emitEvent: false});
          this.cadAmountControl.disable();
        }
      })
    );

    /* If the date control changes, and a foreign currency is selected we should trigger a new conversion */
    this.valueChangeSubscriptions.push(
      this.dateControl.valueChanges.subscribe(value => {
        if (this.foreignSelected) {
          this.runConversion();
        }
      })
    );

    // Mark the form fields as touched so that they display validation errors immediately (without waiting for at least
    // 1 blur event)
    this.fxAmountControl.markAsTouched();
    this.cadAmountControl.markAsTouched();

    /* If the foreign currency amount changes, we should update the UI with the conversion */
    this.valueChangeSubscriptions.push(
      this.fxAmountControl.valueChanges.subscribe(value => {
        if (value && this.foreignSelected && this.toCAD && this.fxAmountControl.valid) {
          this.runConversion();
        } else if (this.toCAD && (this.fxAmountControl.invalid || !value)) {
          this.cadAmountControl.setValue('', {emitEvent: false});
          this.lastConversion = null;
        }
      })
    );

    /* If the CAD amount changes, we should update the UI with the conversion */
    this.valueChangeSubscriptions.push(
      this.cadAmountControl.valueChanges.subscribe(value => {
        if (value && this.foreignSelected && !this.toCAD && this.cadAmountControl.valid) {
          this.runConversion();
        } else if (!this.toCAD && (this.cadAmountControl.invalid || !value)) {
          this.fxAmountControl.setValue('', {emitEvent: false});
          this.lastConversion = null;
        }
      })
    );

    // Start a timer to check for new rate information
    this.rateUpdateInterval = setInterval(() => this.handleRateUpdateTimer(), this.rateUpdateTimeout)
  }

  ngOnDestroy() {
    clearInterval(this.rateUpdateInterval);
    this.rateUpdateInterval = null;
  }

  /**
   * Figure out whether or not we should prompt the user to fetch new rates, and prompt them if we should
   **/
  handleRateUpdateTimer() {
    let newRatesAvailable = this.newRatesAvailable();
    if (newRatesAvailable && this.userSkippedRateRefresh) {
      // Text will be shown on the component indicating that the user skipped this
    } else if (newRatesAvailable && !this.userSkippedRateRefresh) {
      // Prompt the user to update rates
      this.promptRateFetch();
    }
  }

  /* Run the conversion, update state to reflect the conversion result as well as metadata on the conversion rate */
  runConversion() {
    if (this.toCAD) {
      if (!this.fxAmountControl.value) {
        return;
      }
      let [cadConverted, rateDate] = this.conversionService.convert(this.fxAmountControl.value, this.foreignSelection.alphaCode, 'CAD', this.dateControl.value);
      let [conversionRate, _] = this.conversionService.conversionRate(this.foreignSelection.alphaCode, 'CAD', this.dateControl.value);
      this.lastConversion = [this.foreignSelection.alphaCode, 'CAD', conversionRate, rateDate];
      this.cadAmountControl.setValue(cadConverted.toFixed(4), {emitEvent: false});
    } else {
      if (!this.cadAmountControl.value) {
        return;
      }
      let [fxConverted, rateDate] = this.conversionService.convert(this.cadAmountControl.value, 'CAD', this.foreignSelection.alphaCode, this.dateControl.value);
      let [conversionRate, _] = this.conversionService.conversionRate('CAD', this.foreignSelection.alphaCode, this.dateControl.value);
      this.lastConversion = ['CAD', this.foreignSelection.alphaCode, conversionRate, rateDate]
      this.fxAmountControl.setValue(fxConverted.toFixed(4), {emitEvent: false});
    }
  }

  /* Filters out remaining valid currencies based on user input so far (foreign currency selection field) */
  private _filterRemainingValid(value: string): CurrencyMetadata[] {
    if (!value || typeof value !== "string") {
      /* All options are valid if the field is empty, or if it has finally returned an object */
      return this.options;
    }

    const filterValue = value.toLowerCase();
    return this.options.filter(option =>
      (option.fullName.toLowerCase() + " " + option.alphaCode.toLowerCase()).includes(filterValue)
    );
  }

  /* Conversion direction is switching to FX -> CAD */
  switchFXToCAD() {
    if (this.foreignSelected){
      // If conversion direction was already -> CAD, we won't auto-select the amount field
      let switching = this.toCAD ? false : true;

      this.toCAD = true;
      setTimeout(() => {
        this.fxAmountControl.enable();
        this.cadAmountControl.disable();

        // Always focus the element
        this.inputFX.nativeElement.focus();
        if (switching){
          // Highlight the content if the conversion direction changes, the user likely wants to try a new value
          this.inputFX.nativeElement.select();
        }
      }, 0);
    }
  }

  /* Conversion direction is switching to CAD -> FX */
  switchCADToFX() {
    if (this.foreignSelected) {
      // If conversion direction was already -> FX, we won't auto-select the amount field
      let switching = !this.toCAD ? false : true;

      this.toCAD = false;
      setTimeout(() => {
        this.fxAmountControl.disable();
        this.cadAmountControl.enable();

        // Always focus the element
        this.inputCAD.nativeElement.focus();
        if (switching) {
          // Highlight the content if the conversion direction changes, the user likely wants to try a new value
          this.inputCAD.nativeElement.select();
        }
      }, 0);
    }
  }

  /**
   * Given a CurrencyMetadata, this determines the string content of the currency selection field. This allows for the
   * FormControl to return an object, while showing a friendly string version of it to the user.
   */
  displayFn(currency: CurrencyMetadata) : string {
    if (currency) {
      return currency.fullName + " [" + currency.alphaCode + "]" ?? "";
    } else {
      return "";
    }
  }

  /* Handler for subscription to currency conversion service (currency codes) */
  loadAvailableConversions(codes: string[]) {
    this.options = this.options.filter(currency => {
      return codes.some(code => code == currency.alphaCode);
    })

    /**
     * When the foreign currency field changes, it will pick up remaining valid options from this Observable
     *
     * We set this observable after getting valid currency codes so that we know the filtering function will have access
     * to dynamically obtained values, and not the set of defaults loaded from a static file which the
     * `CurrencyConversionService` provides.
     **/
    this.filteredOptions = this.fxCurrencyControl.valueChanges
      .pipe(
        startWith(''),
        map(value => this._filterRemainingValid(value))
      );

    this.state = ConverterState.fetchingExchangeRates;
  }

  /* Handler for subscription to currency conversion service (historical conversion rates) */
  loadAvailableRates(rates) {
    // The listing lets us figure out the acceptable range of conversion dates
    let rangeStart = rates['observations'][0]['d'];
    let rangeEnd = rates['observations'][rates['observations'].length - 1]['d'];

    let dateStart = mtz.tz(rangeStart + "T00:00:00", 'America/Toronto').toDate();
    let dateEnd = mtz.tz(rangeEnd + "T00:00:00", 'America/Toronto').toDate();

    this.minDate = dateStart;
    this.maxDate = mtz.utc().tz('America/Toronto').startOf('day').toDate();

    // We store valid conversion dates, but as noted in the template, it's impossible to use this class variable in a
    // dynamic filtering function for the datepicker. (you can re-bind `this` to be the component class when setting
    // up the filtering callback, but then the datepicker stops working...). Instead, the user can select any date from
    // minDate to maxDate. If Angular Material ever gets patched, this information could make the datepicker more
    // user-friendly and intuitive.
    this.validConversionDates = this.conversionService.getValidConversionDates();

    this.dateControl.setValue(this.maxDate);

    // Some of the conversion data from BoC has certain rates for only part of the full time range. We will filter out
    // conversions that aren't available across the entire range of observations
    this.options = this.options.filter((currency : CurrencyMetadata) => {
      let alphaCode = currency.alphaCode;
      return rates['observations'].every((convDate) => {
        let desiredKey = `FX${alphaCode}CAD`;
        return Object.keys(convDate).some(convKey => convKey == desiredKey);
      });
    });

    // Keep track of when we last fetched rates, as BoC will publish new rates at 16:30 ET on weekdays, and we want to
    // be able to prompt the user to fetch the new rates.
    this.easternTimeLastRateFetch = mtz.utc().tz('America/Toronto').toDate();

    this.state = ConverterState.ready;
  }

  /**
   * If the component decides that there are new rates to be fetched, call this function to prompt the user
   **/
  promptRateFetch() {
    const dialogRef = this.newRatesPrompt.open(DialogPromptRateCheck, {
      maxWidth: null,
      width: 'calc(min(100%, 64rem))',
      position: { top: "16.2vh"},
      disableClose: true
    });

    dialogRef.afterClosed().subscribe(fetchRates => {
      // If the user agreed to fetch the new rates, we'll reset the component to kick that process off
      if (fetchRates) {
        // We're calling ngOnInit() again, so make sure the old subscriptions to form changes are cleaned up
        this.valueChangeSubscriptions.map((s) => s.unsubscribe());
        this.valueChangeSubscriptions = [];

        // these @ViewChild() elements won't be accessible during ngOnInit(), and if we don't blur these form fields
        // before everything is reset, Angular Material's CSS makes the last selected currency amount field appear
        // focused.
        this.inputFX.nativeElement.blur();
        this.inputCAD.nativeElement.blur();

        // Stop the rate update timer, it will be restarted on initialization
        clearInterval(this.rateUpdateInterval);
        this.rateUpdateInterval = null;

        if (this._forceUpdatePrompt) {
          console.debug("unsetting forceUpdatePrompt");
          this._forceUpdatePrompt = false;
        }

        // Re-run the component from the beginning, which will go and fetch the newest conversion rates
        this.ngOnInit();
      } else {
        // remember this so we don't prompt them again
        this.userSkippedRateRefresh = true;
      }
    })
  }

  /**
   * returns true if it's a weekday, and the user can fetch the latest conversion rates. The user can fetch the latest
   * conversion rates if:
   *
   * 1. They started using the app before 16:30 ET, AND
   * 2. It is now equal to or after 16:30 ET on the day that they started using the app
   *
   * The parameters `now` and `startedAt` are used for testing. When not provided, the function will use component
   * variables to work out whether or not it's time to re-fetch conversion rates.
   **/
  newRatesAvailable(now?: Date | null, startedAt?: Date) {
    if(this._forceUpdatePrompt) {
      return true;
    }

    let nowEasternTime = now ? mtz(now) : mtz.utc().tz('America/Toronto');
    let lastFetch = startedAt ? mtz(startedAt) : mtz(this.easternTimeLastRateFetch);

    let nowEasternWeekday = nowEasternTime.isoWeekday()
    let isWeekday = nowEasternWeekday >= 1 && nowEasternWeekday <= 5;

    if (isWeekday) {
      let checkRatesAfter = mtz(lastFetch).startOf('day')
        .hour(this.fetchRatesAfterHour)
        .minute(this.fetchRatesAfterMinute);

      if (lastFetch.isBefore(checkRatesAfter) && nowEasternTime.isSameOrAfter(checkRatesAfter)) {
        // We will offer to fetch rates if it's after 16:30 ET on the last day that rates were fetched
        return true;
      }
    }

    return false;
  }

  /* when this.state changes, perform an appropriate action (loading screen) */
  set state(s: ConverterState) {
    /* initiate actions related to state change */
    switch(s) {
      case ConverterState.fetchingCurrencies:
        this.conversionService.getAvailableConversions().subscribe({
          next: conversions => this.loadAvailableConversions(conversions),
          error: error => this.state = ConverterState.loadingError,
        });
        break;
      case ConverterState.fetchingExchangeRates:
        this.conversionService.getConversionRates().subscribe({
          next: rates => this.loadAvailableRates(rates),
          error: error => this.state = ConverterState.loadingError,
        });
        break;
      case ConverterState.ready:
        console.log("converter is ready");
        break;
      case ConverterState.loadingError:
        console.error("failed to load data from Bank of Canada");
        break;
    }

    this.currentStateSubject.next(s.toString());
  }

  /**
   * When the user makes a foreign currency selection, amount controls need to be enabled/disabled according to whether
   * or not a selection is made.
   **/
  set foreignSelected(selected: boolean) {
    if (selected) {
      setTimeout(() => {
        if (this.toCAD) {
          this.fxAmountControl.enable();
        } else {
          this.cadAmountControl.enable();
        }
      }, 0);
    } else {
      setTimeout(() => {
        this.fxAmountControl.disable();
        this.cadAmountControl.disable();
      }, 0);
    }
    this._foreignSelected = selected;
  }
  get foreignSelected() {
    return this._foreignSelected;
  }
}
